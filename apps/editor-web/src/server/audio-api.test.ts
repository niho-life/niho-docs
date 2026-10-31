import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioInfo, Recording, RecordingPage, StartAudioRecordingInput } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { AUDIO_MAX_BYTES, audioLimits } from "../recording/audio-limits";
import { FAKE_STORAGE_PATH, createFakeStorage, type FakeStorage } from "../storage/fake";
import { StorageError, type ObjectStorage } from "../storage/types";
import { AUDIO_START_BODY_MAX_BYTES, audioLimitsRoute, completeAudioRoute, startAudioRoute, type AudioApiDeps, type AudioStore } from "./audio-api";

// 合成のユーザー ID・ファイル名・ダミーのハッシュだけを使う

const ORIGIN = "http://editor.test";
const SHA = "d".repeat(64);
const START = { name: "合成の会議.m4a", contentType: "audio/mp4", sizeBytes: 5, sha256: SHA };

type Row = {
  page: RecordingPage;
  owner: string;
  deleted: boolean;
  recording: Recording;
  assetId: string | null;
  uploadKey: string | null;
  requestHash: string | null;
  sha256: string;
};

/** メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない行だけ、冪等キー、大きさの照合）。 */
function memoryStore() {
  const rows: Row[] = [];
  const inputs: Array<{ owner: string; input: StartAudioRecordingInput }> = [];
  const find = (owner: string, id: string) => rows.find((row) => row.page.id === id && row.owner === owner && !row.deleted) ?? null;
  const store: AudioStore = {
    startAudioRecording: async (owner, input) => {
      inputs.push({ owner, input });
      const existing = input.uploadKey === null ? undefined : rows.find((row) => row.owner === owner && row.uploadKey === input.uploadKey);
      if (existing) {
        if (existing.deleted || existing.requestHash !== input.requestHash) return { status: "conflict" };
        return { status: "existing", page: existing.page, recording: existing.recording, assetId: existing.assetId! };
      }
      const now = new Date(0).toISOString();
      const expiresAt = new Date(input.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const page: RecordingPage = { id: randomUUID(), kind: "rec", title: input.title, lang: input.lang, createdAt: now, updatedAt: now };
      const recording: Recording = {
        revision: 1,
        source: "audio",
        language: input.lang,
        engine: null,
        durationSec: input.durationSec,
        sourceName: input.sourceName,
        sourceSha256: null,
        segments: [],
        speakerNames: {},
        audio: { status: "uploading", bytes: input.bytes, contentType: input.contentType, expiresAt },
        createdAt: now,
        updatedAt: now,
      };
      rows.push({ page, owner, deleted: false, recording, assetId: input.assetId, uploadKey: input.uploadKey, requestHash: input.requestHash, sha256: input.sha256 });
      return { status: "created", page, recording, assetId: input.assetId };
    },
    completeAudioUpload: async (owner, id, stored) => {
      const row = find(owner, id);
      if (!row?.recording.audio || !row.assetId) return null;
      if (row.recording.audio.status === "uploaded") return { status: "ok", recording: row.recording };
      if (row.recording.audio.bytes !== stored.sizeBytes) return { status: "size_mismatch" };
      row.recording = { ...row.recording, audio: { ...row.recording.audio, status: "uploaded" } };
      return { status: "ok", recording: row.recording };
    },
    audioInfo: async (owner, id): Promise<AudioInfo | null> => {
      const row = find(owner, id);
      if (!row?.recording.audio || !row.assetId) return null;
      const { status, bytes, contentType, expiresAt } = row.recording.audio;
      return { assetId: row.assetId, objectPath: `audio/${row.assetId}`, status, bytes, contentType, sha256: row.sha256, expiresAt };
    },
    getRecording: async (owner, id) => find(owner, id)?.recording ?? null,
  };
  return { store, rows, inputs };
}

/** 音声の API が呼ぶのは getSession だけ。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the audio API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function deps(userId: string | null, store: AudioStore | null, storage: ObjectStorage | null, extra: Partial<AudioApiDeps> = {}): AudioApiDeps {
  return { auth: () => authAs(userId), store: () => store, storage: () => storage, env: {}, ...extra };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", "content-type": "application/json", ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const start = (body: unknown, d: AudioApiDeps, headers: Record<string, string> = {}) => startAudioRoute(request("POST", "/api/recordings/audio/start", body, headers), d);
const complete = (id: string, d: AudioApiDeps, headers: Record<string, string> = {}) =>
  completeAudioRoute(request("POST", `/api/pages/${id}/recording/audio/complete`, undefined, headers), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

function tokenOf(url: string): string {
  return url.slice(FAKE_STORAGE_PATH.length);
}

/** 開始して、偽の保存先に bytes 個のバイトを置き、ページの id を返す。 */
async function startAndPut(storage: FakeStorage, d: AudioApiDeps, bytes: number, body: object = START) {
  const response = await start(body, d);
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(storage.putFakeObject(tokenOf(created.upload.url), new Uint8Array(bytes), null)).toBe("ok");
  return created.page.id as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/recordings/audio/limits", () => {
  it("answers the limits to a signed-in user, and 401 otherwise", async () => {
    const ok = await audioLimitsRoute(request("GET", "/api/recordings/audio/limits"), { auth: () => authAs("user-a") });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await ok.json()).toEqual(audioLimits());
    const anonymous = await audioLimitsRoute(request("GET", "/api/recordings/audio/limits"), { auth: () => authAs(null) });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toBe('{"error":"unauthorized"}');
  });
});

describe("POST /api/recordings/audio/start", () => {
  it("creates the recording for the signed-in owner and answers 201 with the page, the recording and an upload ticket", async () => {
    const { store, inputs } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const assetId = randomUUID();
    const response = await start({ ...START, lang: "en", durationSec: 3.5 }, deps("user-a", store, storage, { newAssetId: () => assetId }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["page", "recording", "speakers", "upload"]);
    expect(body.page).toMatchObject({ kind: "rec", title: "合成の会議", lang: "en" });
    expect(body.recording).toMatchObject({ revision: 1, source: "audio", language: "en", durationSec: 3.5, sourceName: "合成の会議.m4a", segments: [] });
    expect(body.recording.audio).toEqual({ status: "uploading", bytes: 5, contentType: "audio/mp4", expiresAt: expect.any(String) });
    expect(body.speakers).toEqual([]);
    expect(body.upload).toEqual({ url: expect.stringMatching(/^\/api\/dev\/fake-storage\//), method: "PUT", headers: { "Content-Type": "audio/mp4" }, expiresAt: expect.any(String), maxBytes: 5 });

    expect(startUpload).toHaveBeenCalledWith({ objectPath: `audio/${assetId}`, contentType: "audio/mp4", sizeBytes: 5, origin: ORIGIN });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.owner).toBe("user-a");
    expect(inputs[0]!.input).toEqual({
      assetId,
      title: "合成の会議",
      lang: "en",
      sourceName: "合成の会議.m4a",
      contentType: "audio/mp4",
      bytes: 5,
      sha256: SHA,
      durationSec: 3.5,
      uploadKey: null,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      retentionDays: 30,
    });
  });

  it("answers 401, 403, 503 storage_unavailable and 503 unavailable in that order, touching nothing", async () => {
    const { store, inputs } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    expect(await snapshot(await start(START, deps(null, store, storage)))).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }]) {
      expect(await snapshot(await start(START, deps("user-a", store, storage), headers))).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    }
    const noOrigin = new Request(`${ORIGIN}/api/recordings/audio/start`, { method: "POST", headers: { host: "editor.test", "content-type": "application/json" }, body: JSON.stringify(START) });
    expect((await startAudioRoute(noOrigin, deps("user-a", store, storage))).status).toBe(403);
    const off = await start(START, deps("user-a", store, null));
    expect(off.status).toBe(503);
    expect(await off.text()).toBe('{"error":"storage_unavailable"}');
    const noDb = await start(START, deps("user-a", null, storage));
    expect(noDb.status).toBe(503);
    expect(await noDb.text()).toBe('{"error":"unavailable"}');
    expect(startUpload).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(0);
  });

  it("refuses a request over the limits before anything is stored, with a reason", async () => {
    const { store, inputs } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const cases: Array<[unknown, string, Record<string, string>?]> = [
      ["not json", "body"],
      [[START], "body"],
      [{ ...START, extra: 1 }, "body"],
      [START, "idempotency_key", { "idempotency-key": "not-a-uuid" }],
      [{ ...START, name: "dir/合成.m4a" }, "name"],
      [{ ...START, contentType: "text/vtt" }, "content_type"],
      [{ ...START, name: "合成.vtt" }, "extension"],
      [{ ...START, name: "合成.mp3" }, "extension"],
      [{ ...START, sizeBytes: 0 }, "size"],
      [{ ...START, sizeBytes: AUDIO_MAX_BYTES + 1 }, "too_large"],
      [{ ...START, sha256: "x" }, "sha256"],
      [{ ...START, lang: "fr" }, "lang"],
      [{ ...START, durationSec: -1 }, "duration"],
      [{ ...START, durationSec: 6 * 60 * 60 + 1 }, "too_long"],
    ];
    for (const [body, reason, headers] of cases) {
      const response = await start(body, deps("user-a", store, storage), headers);
      expect(response.status, reason).toBe(400);
      expect(await response.text()).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
    const wrongType = await startAudioRoute(
      new Request(`${ORIGIN}/api/recordings/audio/start`, { method: "POST", headers: { host: "editor.test", origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify(START) }),
      deps("user-a", store, storage),
    );
    expect(await wrongType.text()).toBe('{"error":"bad_request","reason":"body"}');
    expect(startUpload).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(0);
  });

  it("answers 413 to a body over 16 KiB, declared or streamed", async () => {
    const { store, inputs } = memoryStore();
    const storage = createFakeStorage();
    const huge = JSON.stringify({ ...START, name: `${"a".repeat(AUDIO_START_BODY_MAX_BYTES)}.m4a` });
    const declared = await start(huge, deps("user-a", store, storage));
    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe('{"error":"payload_too_large"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const streamed = await startAudioRoute(
      new Request(`${ORIGIN}/api/recordings/audio/start`, { method: "POST", headers: { host: "editor.test", origin: ORIGIN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit),
      deps("user-a", store, storage),
    );
    expect(streamed.status).toBe(413);
    expect(inputs).toHaveLength(0);
  });

  it("answers 502 storage_failed when the storage fails, writes nothing, and logs only the route and the code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of ["unavailable", "rejected"] as const) {
      const { store, inputs } = memoryStore();
      const storage: ObjectStorage = {
        kind: "gcs",
        startUpload: async () => {
          throw new StorageError(code);
        },
        stat: async () => null,
        readObject: async () => null,
      };
      const response = await start(START, deps("user-a", store, storage));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('{"error":"storage_failed"}');
      expect(inputs).toHaveLength(0);
    }
    for (const call of errors.mock.calls) {
      expect(call[1]).toEqual({ route: "POST /api/recordings/audio/start", code: expect.stringMatching(/^(unavailable|rejected)$/) });
    }
  });

  it("returns the same recording for the same Idempotency-Key and content: 200 with a new ticket while uploading, upload: null once done", async () => {
    const { store, rows } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const key = randomUUID();
    const first = await start(START, d, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const created = await first.json();

    const replay = await start(START, d, { "idempotency-key": key.toUpperCase() });
    expect(replay.status).toBe(200);
    const again = await replay.json();
    expect(again.page).toEqual(created.page);
    expect(again.recording).toEqual(created.recording);
    expect(again.upload.url).not.toBe(created.upload.url);
    expect(again.upload.maxBytes).toBe(5);
    expect(rows).toHaveLength(1);

    // 作り直した ticket も同じ場所（最初の資産）に置く
    expect(storage.putFakeObject(tokenOf(again.upload.url), new Uint8Array(5), null)).toBe("ok");
    expect(storage.putFakeObject(tokenOf(created.upload.url), new Uint8Array(5), null), "the first ticket points at the same object").toBe("exists");
    expect((await complete(created.page.id, d)).status).toBe(200);

    const done = await start(START, d, { "idempotency-key": key });
    expect(done.status).toBe(200);
    const doneBody = await done.json();
    expect(doneBody.upload).toBeNull();
    expect(doneBody.recording.audio.status).toBe("uploaded");

    const conflict = await start({ ...START, sizeBytes: 6 }, d, { "idempotency-key": key });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe('{"error":"idempotency_conflict"}');
    expect(rows).toHaveLength(1);

    // キーが無ければ別の録音
    await start(START, d);
    await start(START, d);
    expect(rows).toHaveLength(3);
  });
});

describe("POST /api/pages/{id}/recording/audio/complete", () => {
  it("marks the upload done when the stored size matches, and stays done without asking the storage again", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const id = await startAndPut(storage, d, 5);
    const stat = vi.spyOn(storage, "stat");
    const response = await complete(id, d);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["recording", "speakers"]);
    expect(body.recording.audio).toEqual({ status: "uploaded", bytes: 5, contentType: "audio/mp4", expiresAt: expect.any(String) });
    expect(stat).toHaveBeenCalledTimes(1);

    const again = await complete(id, d);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    expect(stat, "a finished upload is not checked again").toHaveBeenCalledTimes(1);
  });

  it("answers 409 incomplete when the object is missing or its size differs, and changes nothing", async () => {
    const { store, rows } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const missing = (await (await start(START, d)).json()).page.id;
    const response = await complete(missing, d);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe('{"error":"incomplete","reason":"missing"}');

    const wrong = await startAndPut(storage, d, 4);
    const mismatch = await complete(wrong, d);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.text()).toBe('{"error":"incomplete","reason":"size_mismatch"}');
    expect(rows.map((row) => row.recording.audio?.status)).toEqual(["uploading", "uploading"]);
  });

  it("answers the same 404 for another owner's page, an unknown or malformed id, a trashed page, and a page without audio", async () => {
    const { store, rows } = memoryStore();
    const storage = createFakeStorage();
    const theirs = await startAndPut(storage, deps("user-b", store, storage), 5);
    const trashed = await startAndPut(storage, deps("user-a", store, storage), 5);
    rows.find((row) => row.page.id === trashed)!.deleted = true;
    const vtt = randomUUID();
    rows.push({
      page: { id: vtt, kind: "rec", title: "", lang: "ja", createdAt: "", updatedAt: "" },
      owner: "user-a",
      deleted: false,
      recording: { ...rows[0]!.recording, source: "vtt", audio: null },
      assetId: null,
      uploadKey: null,
      requestHash: null,
      sha256: SHA,
    });
    const stat = vi.spyOn(storage, "stat");
    const results = [];
    for (const id of [theirs, randomUUID(), "not-a-uuid", trashed, vtt]) results.push(await snapshot(await complete(id, deps("user-a", store, storage))));
    expect(results[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    expect(stat).not.toHaveBeenCalled();
    expect(rows.find((row) => row.page.id === theirs)?.recording.audio?.status).toBe("uploading");
  });

  it("answers 401, 403, 503 and 502 like the other routes, without internal details", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const id = await startAndPut(storage, deps("user-a", store, storage), 5);
    expect((await complete(id, deps(null, store, storage))).status).toBe(401);
    expect((await complete(id, deps("user-a", store, storage), { origin: "https://evil.example" })).status).toBe(403);
    expect(await (await complete(id, deps("user-a", store, null))).text()).toBe('{"error":"storage_unavailable"}');
    expect(await (await complete(id, deps("user-a", null, storage))).text()).toBe('{"error":"unavailable"}');
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: ObjectStorage = {
      kind: "gcs",
      startUpload: async () => {
        throw new StorageError("unavailable");
      },
      stat: async () => {
        throw new StorageError("unavailable");
      },
      readObject: async () => null,
    };
    const failed = await complete(id, deps("user-a", store, failing));
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('{"error":"storage_failed"}');

    const broken: AudioStore = { ...store, audioInfo: async () => Promise.reject(Object.assign(new Error(`SELECT * FROM assets WHERE id = '${id}'`), { code: "XX000" })) };
    const internal = await complete(id, deps("user-a", broken, storage));
    expect(internal.status).toBe(500);
    expect(await internal.text()).toBe('{"error":"internal"}');
  });
});
