import { describe, expect, it, vi } from "vitest";
import { AudioUploadError, completeAudioUpload, getAudioLimits, putAudio, startAudioUpload, type AudioUploadTicket } from "./audio-upload-client";

// 合成の値だけ（ticket の url はダミー）
const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const KEY = "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f";
const SHA = "e".repeat(64);
const LIMITS = { maxBytes: 2147483648, maxDurationSec: 21600, retentionDays: 30, extensions: ["m4a", "mp3"], contentTypes: ["audio/mp4", "audio/mpeg"] };
const TICKET: AudioUploadTicket = { url: "https://storage.example.test/upload?session=synthetic", method: "PUT", headers: { "Content-Type": "audio/mp4" }, expiresAt: "2030-01-08T00:00:00.000Z", maxBytes: 3 };
const RECORDING = { revision: 1, source: "audio", segments: [], audio: { status: "uploading", bytes: 3, contentType: "audio/mp4", expiresAt: "2030-01-31T00:00:00.000Z" } };
const PAGE = { id: ID, kind: "rec", title: "合成", lang: "ja", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("audio upload client", () => {
  it("reads the limits from the same origin, uncached", async () => {
    const fetchMock = respond(200, { ...LIMITS, extra: "dropped" });
    expect(await getAudioLimits(fetchMock as unknown as typeof fetch)).toEqual(LIMITS);
    expect(fetchMock).toHaveBeenCalledWith("/api/recordings/audio/limits", { method: "GET", credentials: "same-origin", cache: "no-store" });
    await expect(getAudioLimits(respond(200, { maxBytes: "x" }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 500 });
    await expect(getAudioLimits(respond(401, { error: "unauthorized" }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 401, error: "unauthorized" });
  });

  it("starts an upload with the JSON body and the Idempotency-Key, and returns the ticket", async () => {
    const fetchMock = respond(201, { page: PAGE, recording: RECORDING, speakers: [], upload: TICKET });
    const started = await startAudioUpload({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA, lang: "en", durationSec: 1.5 }, { idempotencyKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(started).toEqual({ status: 201, page: PAGE, recording: RECORDING, speakers: [], upload: TICKET });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/recordings/audio/start");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "idempotency-key": KEY } });
    expect(JSON.parse(init.body as string)).toEqual({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA, lang: "en", durationSec: 1.5 });

    const replay = respond(200, { page: PAGE, recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } }, speakers: [], upload: null });
    const done = await startAudioUpload({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA }, { fetch: replay as unknown as typeof fetch });
    expect(done.status).toBe(200);
    expect(done.upload).toBeNull();
    const [, replayInit] = replay.mock.calls[0] as unknown as [string, RequestInit];
    expect(replayInit.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(replayInit.body as string)).toEqual({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA });
  });

  it("turns refusals into AudioUploadError with the server's code and reason, and refuses a malformed answer", async () => {
    const input = { name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA };
    for (const [status, body] of [
      [400, { error: "bad_request", reason: "too_large" }],
      [409, { error: "idempotency_conflict" }],
      [503, { error: "storage_unavailable" }],
      [502, { error: "storage_failed" }],
    ] as const) {
      const error = await startAudioUpload(input, { fetch: respond(status, body) as unknown as typeof fetch }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AudioUploadError);
      expect(error).toMatchObject({ status, error: body.error, reason: "reason" in body ? body.reason : null });
    }
    await expect(startAudioUpload(input, { fetch: respond(201, { page: PAGE, recording: RECORDING, upload: { ...TICKET, method: "POST" } }) as unknown as typeof fetch })).rejects.toMatchObject({ status: 500 });
    await expect(startAudioUpload(input, { fetch: respond(201, { page: PAGE }) as unknown as typeof fetch })).rejects.toMatchObject({ status: 500 });
    await expect(startAudioUpload(input, { idempotencyKey: "not-a-uuid", fetch: respond(201, {}) as unknown as typeof fetch })).rejects.toBeInstanceOf(TypeError);
  });

  it("PUTs the file to the ticket url with its headers and no credentials; 412 means it is already there", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const fetchMock = respond(200, undefined);
    await putAudio(TICKET, file, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(TICKET.url, { method: "PUT", headers: { "Content-Type": "audio/mp4" }, body: file, credentials: "omit", cache: "no-store" });
    await expect(putAudio(TICKET, file, respond(412, undefined) as unknown as typeof fetch)).resolves.toBeUndefined();
    const failed = await putAudio(TICKET, file, respond(403, { secret: "storage body" }) as unknown as typeof fetch).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ status: 403, error: null, reason: null });
    expect(String(failed)).not.toContain(TICKET.url);
  });

  it("completes the upload for the page and reports missing or size_mismatch", async () => {
    const fetchMock = respond(200, { recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } }, speakers: [] });
    const done = await completeAudioUpload(ID, fetchMock as unknown as typeof fetch);
    expect(done.recording.audio?.status).toBe("uploaded");
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/recording/audio/complete`, { method: "POST", credentials: "same-origin", cache: "no-store" });
    await expect(completeAudioUpload(ID, respond(409, { error: "incomplete", reason: "size_mismatch" }) as unknown as typeof fetch)).rejects.toMatchObject({
      status: 409,
      error: "incomplete",
      reason: "size_mismatch",
    });
    const encoded = respond(404, { error: "not_found" });
    await expect(completeAudioUpload("../search?q=x", encoded as unknown as typeof fetch)).rejects.toMatchObject({ status: 404 });
    expect((encoded.mock.calls[0] as unknown as [string])[0]).toBe("/api/pages/..%2Fsearch%3Fq%3Dx/recording/audio/complete");
  });
});
