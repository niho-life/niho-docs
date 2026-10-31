import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStorage } from "./fake";
import { GCS_JSON_BASE, createGcsStorage } from "./gcs";
import { StorageError } from "./types";

// 値は明らかなダミーだけ（実際の bucket・token・音声ではない）
const BUCKET = "synthetic-test-bucket";
const TOKEN = "synthetic-access-token-0123456789";
const OBJECT = "audio/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

type Call = { url: string; init: RequestInit };

function fakeFetch(...responses: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

function expectNoSecrets(error: unknown) {
  expect(error).toBeInstanceOf(StorageError);
  const visible = [String(error), (error as Error).message, JSON.stringify(error), (error as Error).stack ?? ""].join("\n");
  for (const secret of [TOKEN, BUCKET, OBJECT, "6f1d0d7c", "googleapis"]) expect(visible).not.toContain(secret);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fake storage: readObject (also used by the transcription)", () => {
  it("streams the object that was put, and answers null for a missing object", async () => {
    const storage = createFakeStorage();
    const ticket = await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 5, origin: null });
    expect(storage.putFakeObject(ticket.url.split("/").pop()!, BYTES, "audio/mp4")).toBe("ok");
    const opened = await storage.readObject(OBJECT);
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBe("audio/mp4");
    expect(await readAll(opened!.body)).toEqual([1, 2, 3, 4, 5]);
    // 読み手が中身を書き換えても、保存先の中身は変わらない
    const again = await storage.readObject(OBJECT);
    const reader = again!.body.getReader();
    const { value } = await reader.read();
    value!.fill(0);
    expect(await readAll((await storage.readObject(OBJECT))!.body)).toEqual([1, 2, 3, 4, 5]);
    expect(await storage.readObject("audio/6f1d0d7c-6f6c-4c39-9a52-000000000000")).toBeNull();
    await expect(storage.readObject("../secret")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("GCS storage: readObject (identity encoding, header-only timeout)", () => {
  it("GETs the object with alt=media, only the bearer token and identity encoding, without following redirects", async () => {
    const { fetch, calls } = fakeFetch(
      new Response(BYTES, { status: 200, headers: { "content-length": "5", "content-type": "audio/mp4" } }),
    );
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    const opened = await storage.readObject(OBJECT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${GCS_JSON_BASE}${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Accept-Encoding": "identity" });
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBe("audio/mp4");
    expect(await readAll(opened!.body)).toEqual([1, 2, 3, 4, 5]);
  });

  it("uses the stored length when the response has no Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES);
        controller.close();
      },
    });
    const response = new Response(body, { status: 200, headers: { "x-goog-stored-content-length": "5" } });
    const storage = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(response).fetch, accessToken: async () => TOKEN });
    const opened = await storage.readObject(OBJECT);
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBeNull();
  });

  it("answers null for 404 and maps the other failures without leaking the token, the bucket or the path", async () => {
    const make = (response: Response | Error) => createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(response).fetch, accessToken: async () => TOKEN });
    expect(await make(new Response("not found", { status: 404 })).readObject(OBJECT)).toBeNull();
    for (const [response, code] of [
      [new Response(`denied for ${BUCKET}/${OBJECT}`, { status: 403 }), "unavailable"],
      [new Response("busy", { status: 503 }), "unavailable"],
      [new Response("bad", { status: 400 }), "rejected"],
      [new Error(`connect failed ${TOKEN} ${BUCKET}`), "unavailable"],
      [new Response(BYTES, { status: 200, headers: { "content-length": "five" } }), "unavailable"],
    ] as const) {
      try {
        await make(response).readObject(OBJECT);
        throw new Error("expected a failure");
      } catch (error) {
        expectNoSecrets(error);
        expect((error as StorageError).code).toBe(code);
      }
    }
    await expect(make(new Response(null, { status: 200 })).readObject("not a path")).rejects.toBeInstanceOf(StorageError);
    const failingToken = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch().fetch, accessToken: async () => Promise.reject(new Error(TOKEN)) });
    await expect(failingToken.readObject(OBJECT)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("times out only while waiting for the headers, not while the body is read", async () => {
    // header が届くまでに時間切れ: 中断して unavailable
    const hanging = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const slow = createGcsStorage({ bucket: BUCKET, fetch: hanging.fetch, accessToken: async () => TOKEN, timeoutMs: 20 });
    await expect(slow.readObject(OBJECT)).rejects.toMatchObject({ code: "unavailable" });

    // header が届いたあとは、本文の読み取りが時間切れより長くかかっても切らない
    let signal: AbortSignal | undefined;
    let push: ((chunk: Uint8Array | null) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => (chunk ? controller.enqueue(chunk) : controller.close());
      },
    });
    const { fetch } = fakeFetch((call) => {
      signal = call.init.signal ?? undefined;
      return new Response(body, { status: 200, headers: { "content-length": "2" } });
    });
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN, timeoutMs: 20 });
    const opened = await storage.readObject(OBJECT);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal?.aborted).toBe(false);
    push!(new Uint8Array([7]));
    push!(new Uint8Array([8]));
    push!(null);
    expect(await readAll(opened!.body)).toEqual([7, 8]);
  });
});

// 範囲の読み取り（録音の再生 #36 段 3b-2）。中身は位置が分かる並び（i 番目のバイトが i）
const SEQUENCE = Uint8Array.from({ length: 10 }, (_, index) => index);

describe("fake storage: readObject with a range (#36 段 3b-2)", () => {
  async function storageWith(bytes: Uint8Array) {
    const storage = createFakeStorage();
    const ticket = await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: bytes.byteLength, origin: null });
    expect(storage.putFakeObject(ticket.url.split("/").pop()!, bytes, "audio/mp4")).toBe("ok");
    return storage;
  }

  it("slices the head, the middle and the tail, and reports the range and the whole size", async () => {
    const storage = await storageWith(SEQUENCE);
    const head = await storage.readObject(OBJECT, { range: { start: 0, end: 0 } });
    expect(head).toMatchObject({ sizeBytes: 1, range: { start: 0, end: 0 }, totalBytes: 10, contentType: "audio/mp4" });
    expect(await readAll(head!.body)).toEqual([0]);
    const middle = await storage.readObject(OBJECT, { range: { start: 2, end: 5 } });
    expect(middle).toMatchObject({ sizeBytes: 4, range: { start: 2, end: 5 }, totalBytes: 10 });
    expect(await readAll(middle!.body)).toEqual([2, 3, 4, 5]);
    const tail = await storage.readObject(OBJECT, { range: { start: 7, end: 9 } });
    expect(await readAll(tail!.body)).toEqual([7, 8, 9]);
  });

  it("cuts the end at the end of the object, and refuses a start at or past the end", async () => {
    const storage = await storageWith(SEQUENCE);
    const over = await storage.readObject(OBJECT, { range: { start: 8, end: 100 } });
    expect(over).toMatchObject({ sizeBytes: 2, range: { start: 8, end: 9 }, totalBytes: 10 });
    expect(await readAll(over!.body)).toEqual([8, 9]);
    for (const range of [
      { start: 10, end: 10 },
      { start: 11, end: 20 },
    ]) {
      await expect(storage.readObject(OBJECT, { range })).rejects.toMatchObject({ code: "range_not_satisfiable" });
    }
    // 形の違う範囲は呼び出し側の誤り（rejected）
    for (const range of [
      { start: 5, end: 2 },
      { start: -1, end: 2 },
      { start: 0.5, end: 2 },
    ]) {
      await expect(storage.readObject(OBJECT, { range })).rejects.toMatchObject({ code: "rejected" });
    }
    expect(await storage.readObject("audio/6f1d0d7c-6f6c-4c39-9a52-000000000000", { range: { start: 0, end: 1 } })).toBeNull();
  });

  it("reads without a range exactly as before (no range or whole size in the answer)", async () => {
    const storage = await storageWith(SEQUENCE);
    const whole = await storage.readObject(OBJECT);
    expect(Object.keys(whole!).sort()).toEqual(["body", "contentType", "sizeBytes"]);
    expect(await readAll(whole!.body)).toEqual([...SEQUENCE]);
  });
});

describe("GCS storage: readObject with a range (#36 段 3b-2)", () => {
  const make = (...responses: Parameters<typeof fakeFetch>) => {
    const fetched = fakeFetch(...responses);
    return { storage: createGcsStorage({ bucket: BUCKET, fetch: fetched.fetch, accessToken: async () => TOKEN }), calls: fetched.calls };
  };

  it("sends Range: bytes=start-end with the same GET, and reads the served range and the whole size from Content-Range of a 206", async () => {
    const { storage, calls } = make(
      new Response(SEQUENCE.slice(2, 6), { status: 206, headers: { "content-range": "bytes 2-5/10", "content-length": "4", "content-type": "audio/mp4" } }),
    );
    const opened = await storage.readObject(OBJECT, { range: { start: 2, end: 5 } });
    expect(calls[0]!.url).toBe(`${GCS_JSON_BASE}${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Accept-Encoding": "identity", Range: "bytes=2-5" });
    expect(opened).toMatchObject({ sizeBytes: 4, range: { start: 2, end: 5 }, totalBytes: 10, contentType: "audio/mp4" });
    expect(await readAll(opened!.body)).toEqual([2, 3, 4, 5]);
  });

  it("accepts a 206 whose end is cut at the end of the object, and a large object past 2 GiB", async () => {
    const cut = make(new Response(SEQUENCE.slice(8), { status: 206, headers: { "content-range": "bytes 8-9/10" } }));
    expect(await cut.storage.readObject(OBJECT, { range: { start: 8, end: 100 } })).toMatchObject({ sizeBytes: 2, range: { start: 8, end: 9 }, totalBytes: 10 });
    const big = 3 * 1024 * 1024 * 1024;
    const large = make(new Response(new Uint8Array(2), { status: 206, headers: { "content-range": `bytes 2147483648-2147483649/${big}`, "content-length": "2" } }));
    const opened = await large.storage.readObject(OBJECT, { range: { start: 2147483648, end: 2147483649 } });
    expect(large.calls[0]!.init.headers).toMatchObject({ Range: "bytes=2147483648-2147483649" });
    expect(opened).toMatchObject({ sizeBytes: 2, range: { start: 2147483648, end: 2147483649 }, totalBytes: big });
  });

  it("treats a 200 as the whole object (the range was ignored)", async () => {
    const { storage } = make(new Response(SEQUENCE, { status: 200, headers: { "content-length": "10", "content-type": "audio/mp4" } }));
    const opened = await storage.readObject(OBJECT, { range: { start: 2, end: 5 } });
    expect(opened).toMatchObject({ sizeBytes: 10, range: { start: 0, end: 9 }, totalBytes: 10 });
    expect(await readAll(opened!.body)).toEqual([...SEQUENCE]);
    // 空の object には範囲が無い
    const empty = make(new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "0" } }));
    await expect(empty.storage.readObject(OBJECT, { range: { start: 0, end: 0 } })).rejects.toMatchObject({ code: "range_not_satisfiable" });
  });

  it("maps 416 to range_not_satisfiable and 404 to null, without leaking the token, the bucket or the path", async () => {
    try {
      await make(new Response(`no range for ${BUCKET}/${OBJECT}`, { status: 416, headers: { "content-range": "bytes */10" } })).storage.readObject(OBJECT, { range: { start: 10, end: 12 } });
      throw new Error("expected a failure");
    } catch (error) {
      expectNoSecrets(error);
      expect((error as StorageError).code).toBe("range_not_satisfiable");
    }
    expect(await make(new Response("missing", { status: 404 })).storage.readObject(OBJECT, { range: { start: 0, end: 1 } })).toBeNull();
    // 範囲を求めていない 416 は今までどおり rejected
    await expect(make(new Response("x", { status: 416 })).storage.readObject(OBJECT)).rejects.toMatchObject({ code: "rejected" });
  });

  it("does not trust a 206 whose range or length differs from the request, and cancels its body", async () => {
    const untrusted: Record<string, string>[] = [
      { "content-range": "bytes 0-3/10" },
      { "content-range": "bytes 2-4/10" },
      { "content-range": "bytes 2-5/*" },
      { "content-range": "bytes */10" },
      { "content-range": "bytes 2-5/5" },
      { "content-range": "items 2-5/10" },
      { "content-range": "bytes 2-5/10", "content-length": "9" },
      {},
    ];
    for (const headers of untrusted) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      try {
        await make(new Response(body, { status: 206, headers })).storage.readObject(OBJECT, { range: { start: 2, end: 5 } });
        throw new Error("expected a failure");
      } catch (error) {
        expectNoSecrets(error);
        expect((error as StorageError).code, JSON.stringify(headers)).toBe("unavailable");
      }
      expect(cancelled, JSON.stringify(headers)).toBe(true);
    }
    // 範囲を求めて 200・206 以外の 2xx も信じない
    await expect(make(new Response(null, { status: 204 })).storage.readObject(OBJECT, { range: { start: 0, end: 1 } })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses a malformed range before asking, and keeps the same failure mapping (403 unavailable, 400 rejected)", async () => {
    const none = make();
    await expect(none.storage.readObject(OBJECT, { range: { start: 3, end: 1 } })).rejects.toMatchObject({ code: "rejected" });
    expect(none.calls).toHaveLength(0);
    for (const [response, code] of [
      [new Response(`denied ${TOKEN}`, { status: 403 }), "unavailable"],
      [new Response("bad", { status: 400 }), "rejected"],
      [new Error(`connect failed ${TOKEN} ${BUCKET}`), "unavailable"],
    ] as const) {
      try {
        await make(response).storage.readObject(OBJECT, { range: { start: 0, end: 1 } });
        throw new Error("expected a failure");
      } catch (error) {
        expectNoSecrets(error);
        expect((error as StorageError).code).toBe(code);
      }
    }
  });

  it("does not add a Range header, a range or a whole size when no range is asked (the existing reads)", async () => {
    const { storage, calls } = make(new Response(BYTES, { status: 200, headers: { "content-length": "5" } }));
    const opened = await storage.readObject(OBJECT);
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Accept-Encoding": "identity" });
    expect(Object.keys(opened!).sort()).toEqual(["body", "contentType", "sizeBytes"]);
  });
});
