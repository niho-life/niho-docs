import { imageObjectPath } from "@niho/editor-store";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "../image/image-limits";
import type { ObjectStorage, ReadObject } from "../storage/types";
import { EXPORT_PHOTO_BUDGET_BYTES, storageAssetBytes } from "./export-assets";

// 合成の値だけを使う
const ASSET_A = "11111111-2222-4333-8444-555555555555";
const ASSET_B = "22222222-3333-4444-8555-666666666666";
const SHA = "a".repeat(64);

function stream(bytes: Uint8Array, chunk = 8): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

/** 場所ごとに中身を返す偽の保存先（読み出しだけを使う）。 */
function storageOf(objects: Record<string, Uint8Array | "throws">, options: { chunk?: number } = {}) {
  const paths: string[] = [];
  const storage: ObjectStorage = {
    kind: "fake",
    startUpload: async () => {
      throw new Error("the export never uploads");
    },
    stat: async () => null,
    async readObject(objectPath): Promise<ReadObject | null> {
      paths.push(objectPath);
      const found = objects[objectPath];
      if (found === undefined) return null;
      if (found === "throws") throw new Error("storage is unavailable");
      return { body: stream(found, options.chunk), contentType: "image/jpeg", sizeBytes: found.byteLength };
    },
  };
  return { storage, paths };
}

const asset = (id: string) => ({ id, sha256: SHA, contentType: "image/jpeg" });
const photo = (size: number) => new Uint8Array(size).fill(7);

describe("storageAssetBytes", () => {
  it("reads the photo from the place its id decides, and joins the chunks", async () => {
    const bytes = photo(40);
    const { storage, paths } = storageOf({ [imageObjectPath(ASSET_A)]: bytes }, { chunk: 7 });
    const reader = storageAssetBytes(storage);
    expect(await reader.port.read(asset(ASSET_A))).toEqual(bytes);
    expect(paths).toEqual([imageObjectPath(ASSET_A)]);
    expect(reader.exceeded()).toBe(false);
  });

  it("answers null for a photo the store does not have, and for a store that throws", async () => {
    const { storage } = storageOf({ [imageObjectPath(ASSET_B)]: "throws" });
    const reader = storageAssetBytes(storage);
    expect(await reader.port.read(asset(ASSET_A))).toBeNull();
    expect(await reader.port.read(asset(ASSET_B))).toBeNull();
    // 読めないだけで「大きすぎる」ではない（書き出しは「写真が足りない」として失敗する）
    expect(reader.exceeded()).toBe(false);
  });

  it("stops at the budget and says so, instead of piling the bytes up in memory", async () => {
    const { storage } = storageOf({ [imageObjectPath(ASSET_A)]: photo(30), [imageObjectPath(ASSET_B)]: photo(30) });
    const reader = storageAssetBytes(storage, 40);
    expect((await reader.port.read(asset(ASSET_A)))?.byteLength).toBe(30);
    expect(reader.exceeded()).toBe(false);
    // 2 枚目は残りの予算（10）に収まらない
    expect(await reader.port.read(asset(ASSET_B))).toBeNull();
    expect(reader.exceeded()).toBe(true);
  });

  it("does not read at all once the budget is used up", async () => {
    const { storage, paths } = storageOf({ [imageObjectPath(ASSET_A)]: photo(10), [imageObjectPath(ASSET_B)]: photo(10) });
    const reader = storageAssetBytes(storage, 10);
    expect((await reader.port.read(asset(ASSET_A)))?.byteLength).toBe(10);
    expect(await reader.port.read(asset(ASSET_B))).toBeNull();
    expect(paths).toEqual([imageObjectPath(ASSET_A)]);
    expect(reader.exceeded()).toBe(true);
  });

  it("cancels the stream of a photo over the per-photo limit", async () => {
    const cancel = vi.fn(async () => undefined);
    const storage: ObjectStorage = {
      kind: "fake",
      startUpload: async () => {
        throw new Error("the export never uploads");
      },
      stat: async () => null,
      async readObject(): Promise<ReadObject> {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            // 上限を必ず超える量を流し続ける
            controller.enqueue(photo(1024 * 1024));
            if (sent > 40) controller.close();
          },
          cancel,
        });
        return { body, contentType: "image/jpeg", sizeBytes: IMAGE_MAX_BYTES + 1 };
      },
    };
    const reader = storageAssetBytes(storage);
    expect(await reader.port.read(asset(ASSET_A))).toBeNull();
    expect(cancel).toHaveBeenCalled();
    expect(reader.exceeded()).toBe(true);
  });

  it("keeps the default budget at 200 MiB and the per-photo limit at the image limit", () => {
    expect(EXPORT_PHOTO_BUDGET_BYTES).toBe(200 * 1024 * 1024);
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
