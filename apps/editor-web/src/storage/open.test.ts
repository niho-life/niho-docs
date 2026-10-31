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

describe("fake storage: open", () => {
  it("streams the object that was put, and answers null for a missing object", async () => {
    const storage = createFakeStorage();
    const ticket = await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 5, origin: null });
    expect(storage.putFakeObject(ticket.url.split("/").pop()!, BYTES, "audio/mp4")).toBe("ok");
    const opened = await storage.open(OBJECT);
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBe("audio/mp4");
    expect(await readAll(opened!.stream)).toEqual([1, 2, 3, 4, 5]);
    // 読み手が中身を書き換えても、保存先の中身は変わらない
    const again = await storage.open(OBJECT);
    const reader = again!.stream.getReader();
    const { value } = await reader.read();
    value!.fill(0);
    expect(await readAll((await storage.open(OBJECT))!.stream)).toEqual([1, 2, 3, 4, 5]);
    expect(await storage.open("audio/6f1d0d7c-6f6c-4c39-9a52-000000000000")).toBeNull();
    await expect(storage.open("../secret")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("GCS storage: open", () => {
  it("GETs the object with alt=media, only the bearer token and identity encoding, without following redirects", async () => {
    const { fetch, calls } = fakeFetch(
      new Response(BYTES, { status: 200, headers: { "content-length": "5", "content-type": "audio/mp4" } }),
    );
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    const opened = await storage.open(OBJECT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${GCS_JSON_BASE}${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Accept-Encoding": "identity" });
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBe("audio/mp4");
    expect(await readAll(opened!.stream)).toEqual([1, 2, 3, 4, 5]);
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
    const opened = await storage.open(OBJECT);
    expect(opened?.sizeBytes).toBe(5);
    expect(opened?.contentType).toBeNull();
  });

  it("answers null for 404 and maps the other failures without leaking the token, the bucket or the path", async () => {
    const make = (response: Response | Error) => createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(response).fetch, accessToken: async () => TOKEN });
    expect(await make(new Response("not found", { status: 404 })).open(OBJECT)).toBeNull();
    for (const [response, code] of [
      [new Response(`denied for ${BUCKET}/${OBJECT}`, { status: 403 }), "unavailable"],
      [new Response("busy", { status: 503 }), "unavailable"],
      [new Response("bad", { status: 400 }), "rejected"],
      [new Error(`connect failed ${TOKEN} ${BUCKET}`), "unavailable"],
      [new Response(BYTES, { status: 200, headers: { "content-length": "five" } }), "unavailable"],
    ] as const) {
      try {
        await make(response).open(OBJECT);
        throw new Error("expected a failure");
      } catch (error) {
        expectNoSecrets(error);
        expect((error as StorageError).code).toBe(code);
      }
    }
    await expect(make(new Response(null, { status: 200 })).open("not a path")).rejects.toBeInstanceOf(StorageError);
    const failingToken = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch().fetch, accessToken: async () => Promise.reject(new Error(TOKEN)) });
    await expect(failingToken.open(OBJECT)).rejects.toMatchObject({ code: "unavailable" });
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
    await expect(slow.open(OBJECT)).rejects.toMatchObject({ code: "unavailable" });

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
    const opened = await storage.open(OBJECT);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal?.aborted).toBe(false);
    push!(new Uint8Array([7]));
    push!(new Uint8Array([8]));
    push!(null);
    expect(await readAll(opened!.stream)).toEqual([7, 8]);
  });
});
