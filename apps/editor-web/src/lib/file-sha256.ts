/**
 * ファイル（Blob）の SHA-256 を、全部をメモリに載せずに計算する（#36 段 3b-1。録音の音声の申告の sha256）。
 * 4 MiB ずつ `slice().arrayBuffer()` で読み、8 MiB 処理するごとに画面へ処理を譲る（`setTimeout(0)`）。Web Worker は使わない
 * （Next の bundling を増やさない）。2 GiB では数十秒かかり得るので、進み具合を返し、`AbortSignal` で止められる。
 */
import { Sha256 } from "./sha256-stream";

export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
export const HASH_YIELD_BYTES = 8 * 1024 * 1024;

export type FileSha256Options = {
  /** 処理した割合（0〜1）。読んだ塊ごとに呼ぶ。 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** テスト用: 塊の大きさ・譲る間隔・譲り方。 */
  chunkBytes?: number;
  yieldBytes?: number;
  yieldToUi?: () => Promise<void>;
};

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortError(): DOMException {
  return new DOMException("The hashing was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** 小文字 16 進 64 桁。止められたら AbortError（DOMException）。読めないファイルは読み取りの例外をそのまま投げる。 */
export async function fileSha256(blob: Blob, options: FileSha256Options = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? HASH_CHUNK_BYTES;
  const yieldBytes = options.yieldBytes ?? HASH_YIELD_BYTES;
  const yieldToUi = options.yieldToUi ?? defaultYield;
  const { signal, onProgress } = options;
  const total = blob.size;
  const hash = new Sha256();
  let done = 0;
  let sinceYield = 0;
  throwIfAborted(signal);
  onProgress?.(total === 0 ? 1 : 0);
  while (done < total) {
    const end = Math.min(total, done + chunkBytes);
    const buffer = await blob.slice(done, end).arrayBuffer();
    throwIfAborted(signal);
    hash.update(new Uint8Array(buffer));
    sinceYield += end - done;
    done = end;
    onProgress?.(done / total);
    if (sinceYield >= yieldBytes && done < total) {
      sinceYield = 0;
      await yieldToUi();
      throwIfAborted(signal);
    }
  }
  return hash.digest();
}
