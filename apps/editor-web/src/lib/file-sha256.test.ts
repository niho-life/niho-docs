import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HASH_CHUNK_BYTES, HASH_YIELD_BYTES, fileSha256 } from "./file-sha256";

const reference = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const MiB = 1024 * 1024;

describe("fileSha256", () => {
  it("reads 4 MiB at a time, yields to the page every 8 MiB, and matches node:crypto", async () => {
    expect(HASH_CHUNK_BYTES).toBe(4 * MiB);
    expect(HASH_YIELD_BYTES).toBe(8 * MiB);
    const data = new Uint8Array(randomBytes(20 * MiB + 123));
    const blob = new Blob([data]);
    const slice = vi.spyOn(blob, "slice");
    const yieldToUi = vi.fn(async () => undefined);
    const progress: number[] = [];
    const digest = await fileSha256(blob, { yieldToUi, onProgress: (fraction) => progress.push(fraction) });
    expect(digest).toBe(reference(data));
    // 4 MiB × 5 と残り 123 バイト = 6 回読む。8 MiB・16 MiB を超えたところで 2 回譲る（最後の塊のあとは譲らない）
    expect(slice).toHaveBeenCalledTimes(6);
    expect(slice.mock.calls[0]).toEqual([0, 4 * MiB]);
    expect(slice.mock.calls[5]).toEqual([20 * MiB, 20 * MiB + 123]);
    expect(yieldToUi).toHaveBeenCalledTimes(2);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toHaveLength(7);
  });

  it("yields with setTimeout(0) by default", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const data = new Uint8Array(randomBytes(64));
    expect(await fileSha256(new Blob([data]), { chunkBytes: 8, yieldBytes: 16 })).toBe(reference(data));
    const zeroDelay = timeout.mock.calls.filter((call) => call[1] === 0);
    // 64 バイトを 8 バイトずつ: 16・32・48 バイトのあとで譲る（64 は最後なので譲らない）
    expect(zeroDelay).toHaveLength(3);
    timeout.mockRestore();
  });

  it("handles an empty file and odd chunk sizes", async () => {
    expect(await fileSha256(new Blob([]))).toBe(reference(new Uint8Array(0)));
    const data = new Uint8Array(randomBytes(1000));
    for (const chunkBytes of [1, 7, 63, 64, 65, 999, 1000, 4096]) {
      expect(await fileSha256(new Blob([data]), { chunkBytes, yieldBytes: 100, yieldToUi: async () => undefined }), String(chunkBytes)).toBe(reference(data));
    }
  });

  it("stops with an AbortError when aborted before, between chunks, or while yielding", async () => {
    const data = new Uint8Array(randomBytes(256));
    const before = new AbortController();
    before.abort();
    await expect(fileSha256(new Blob([data]), { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" });

    const between = new AbortController();
    const reads: number[] = [];
    await expect(
      fileSha256(new Blob([data]), {
        chunkBytes: 32,
        signal: between.signal,
        onProgress: (fraction) => {
          reads.push(fraction);
          if (fraction >= 0.25) between.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    // 止めたあとは読み進めない
    expect(reads.at(-1)).toBe(0.25);

    const whileYielding = new AbortController();
    await expect(
      fileSha256(new Blob([data]), {
        chunkBytes: 32,
        yieldBytes: 64,
        signal: whileYielding.signal,
        yieldToUi: async () => whileYielding.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lets a read failure through (the caller says the file cannot be read)", async () => {
    const blob = new Blob([new Uint8Array(10)]);
    vi.spyOn(blob, "slice").mockReturnValue({ arrayBuffer: () => Promise.reject(new DOMException("unreadable", "NotReadableError")) } as unknown as Blob);
    await expect(fileSha256(blob)).rejects.toMatchObject({ name: "NotReadableError" });
  });
});
