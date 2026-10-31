import { describe, expect, it } from "vitest";
import { FAKE_STORAGE_MAX_BYTES, FAKE_STORAGE_PATH, FAKE_TICKET_TTL_MS, createFakeStorage } from "./fake";
import { StorageError, isObjectPath } from "./types";

const PATH = "audio/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

function tokenOf(url: string): string {
  expect(url.startsWith(FAKE_STORAGE_PATH)).toBe(true);
  return url.slice(FAKE_STORAGE_PATH.length);
}

describe("fake object storage", () => {
  it("hands out a same-origin ticket, stores the PUT bytes once, and reports their size", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const storage = createFakeStorage({ now: () => now });
    expect(storage.kind).toBe("fake");
    const ticket = await storage.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: 3, origin: "http://editor.test" });
    expect(ticket).toEqual({
      url: expect.stringMatching(/^\/api\/dev\/fake-storage\/[A-Za-z0-9_-]{43}$/),
      method: "PUT",
      headers: { "Content-Type": "audio/mp4" },
      expiresAt: new Date(now + FAKE_TICKET_TTL_MS).toISOString(),
    });
    const token = tokenOf(ticket.url);
    expect(await storage.stat(PATH)).toBeNull();
    expect(storage.putFakeObject(token, new Uint8Array([1, 2, 3, 4]), null)).toBe("ok");
    expect(await storage.stat(PATH), "the fake does not enforce the declared size").toEqual({ sizeBytes: 4, contentType: "audio/mp4" });
    expect(storage.putFakeObject(token, new Uint8Array([1]), null), "a ticket is used once").toBe("not_found");

    // 既にある場所には置かない（上書きしない）
    const again = await storage.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: 1, origin: null });
    expect(storage.putFakeObject(tokenOf(again.url), new Uint8Array([9]), "audio/mp4")).toBe("exists");
    expect(await storage.stat(PATH)).toEqual({ sizeBytes: 4, contentType: "audio/mp4" });

    // 期限切れ・知らない token・形の違う token は置けない
    const other = "audio/00000000-0000-4000-8000-000000000001";
    const late = await storage.startUpload({ objectPath: other, contentType: "audio/ogg", sizeBytes: 1, origin: null });
    now += FAKE_TICKET_TTL_MS;
    expect(storage.putFakeObject(tokenOf(late.url), new Uint8Array([1]), null), "an expired ticket").toBe("not_found");
    expect(storage.putFakeObject("A".repeat(43), new Uint8Array([1]), null)).toBe("not_found");
    expect(storage.putFakeObject("../x", new Uint8Array([1]), null)).toBe("not_found");
    expect(await storage.stat(other)).toBeNull();
  });

  it("refuses bytes over its limit and paths with the wrong shape", async () => {
    const storage = createFakeStorage();
    const ticket = await storage.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: 1, origin: null });
    expect(storage.putFakeObject(tokenOf(ticket.url), new Uint8Array(FAKE_STORAGE_MAX_BYTES + 1), null)).toBe("too_large");
    for (const objectPath of ["", "/audio/x", "audio/../x", "audio/a/b", "audio/x.m4a", "AUDIO/x", "gs://bucket/audio/x"]) {
      expect(isObjectPath(objectPath), objectPath).toBe(false);
      await expect(storage.startUpload({ objectPath, contentType: "audio/mp4", sizeBytes: 1, origin: null })).rejects.toMatchObject({ code: "rejected" });
      await expect(storage.stat(objectPath)).rejects.toBeInstanceOf(StorageError);
    }
    await expect(storage.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: -1, origin: null })).rejects.toMatchObject({ code: "rejected" });
  });

  it("reads the stored bytes back for the relay, and answers null for what is not there", async () => {
    const storage = createFakeStorage();
    const image = "image/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    expect(await storage.readObject(image)).toBeNull();
    const ticket = await storage.startUpload({ objectPath: image, contentType: "image/png", sizeBytes: 3, origin: null });
    expect(storage.putFakeObject(tokenOf(ticket.url), new Uint8Array([1, 2, 3]), "image/png")).toBe("ok");
    const read = await storage.readObject(image);
    expect(read).toMatchObject({ contentType: "image/png", sizeBytes: 3 });
    expect(new Uint8Array(await new Response(read!.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // 同じ object は何度でも読める（流れは呼ぶたびに作る）
    const second = await storage.readObject(image);
    expect(new Uint8Array(await new Response(second!.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // 形の違う場所は読まない
    for (const objectPath of ["", "image/../x", "IMAGE/x"]) {
      await expect(storage.readObject(objectPath), objectPath).rejects.toBeInstanceOf(StorageError);
    }
  });

  it("keeps separate state per instance unless the state is shared", async () => {
    const a = createFakeStorage();
    const b = createFakeStorage();
    const ticket = await a.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: 1, origin: null });
    expect(b.putFakeObject(tokenOf(ticket.url), new Uint8Array([1]), null)).toBe("not_found");
    expect(a.putFakeObject(tokenOf(ticket.url), new Uint8Array([1]), null)).toBe("ok");
    expect(await b.stat(PATH)).toBeNull();
  });
});
