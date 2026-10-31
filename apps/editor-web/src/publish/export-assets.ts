import "server-only";
import type { AssetBytes } from "@niho/editor-publish";
import { imageObjectPath } from "@niho/editor-store";
import { IMAGE_MAX_BYTES } from "../image/image-limits";
import type { ObjectStorage } from "../storage/types";

/**
 * 書き出し（#41）の写真の読み出し。`exportConnection` は zip を 1 つのメモリの中で組むので、
 * 1 回の書き出しで読む合計に上限を置く（超えたら、それ以降は読まずに「大きすぎる」として断る）。
 *
 * - object の場所は資産の id から決まる（`imageObjectPath`。本文に入るのは id だけ）。
 * - 読めない・大きさが合わない写真は null を返す。`buildExportArchive` がその写真を黙って落とさず、書き出しを失敗にする。
 * - 中身・object の場所・bucket 名をログ・エラーに書かない。
 */

/** 1 回の書き出しで読む写真の合計の上限（200 MiB）。1 枚の上限は画像の上限（20 MiB）と同じ。 */
export const EXPORT_PHOTO_BUDGET_BYTES = 200 * 1024 * 1024;

export type ExportAssetReader = {
  readonly port: AssetBytes;
  /** 上限を超えたので、読まずに断った写真がある。 */
  exceeded: () => boolean;
};

/** 流れを最後まで読み、上限を超えたらその場でやめる（超えた分をメモリに積まない）。 */
async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function storageAssetBytes(storage: ObjectStorage, budgetBytes: number = EXPORT_PHOTO_BUDGET_BYTES): ExportAssetReader {
  let used = 0;
  let over = false;
  return {
    exceeded: () => over,
    port: {
      async read(asset) {
        if (used >= budgetBytes) {
          over = true;
          return null;
        }
        let read;
        try {
          read = await storage.readObject(imageObjectPath(asset.id));
        } catch {
          return null;
        }
        if (!read) return null;
        const limit = Math.min(IMAGE_MAX_BYTES, budgetBytes - used);
        const bytes = await readAll(read.body, limit);
        if (bytes === null) {
          // 1 枚で上限に当たった（残りの予算が足りない・1 枚が画像の上限を超えている）
          over = true;
          return null;
        }
        used += bytes.byteLength;
        return bytes;
      },
    },
  };
}
