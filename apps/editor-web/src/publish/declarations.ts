import { isFaceDest, type FaceDest } from "@niho/editor-publish-contract";
import type { DeclarationSource } from "@niho/editor-publish";

/**
 * 面（NIHO Experience・NIHO）の宣言を、`EDITOR_DESTINATION_DECLARATIONS` の https の URL から読む（#39）。
 * 返すのは読んだ JSON そのもの。検証（知らない kind・欄は宣言ごと拒否）は editor-publish の parseDestinationDeclaration がする。
 *
 * - 短い時間（既定 60 秒）だけメモリに置き、過ぎたら ETag（If-None-Match）で確かめ直す。同じ面を同時に読むときは 1 本にまとめる。
 * - 時間の上限（既定 5 秒）と大きさの上限（既定 64 KiB）を付ける。JSON でない応答は読まない。
 * - redirect は同じ host の https へだけ、3 回まで追う。別の host へは追わない。
 * - 読めなかったら null（その面は「いまは公開できません」）。続けて叩かないよう、しばらく（既定 15 秒）は読みに行かない。
 * - URL・応答の中身はログにも例外にも出さない。
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type FetchedDeclarationsOptions = {
  readonly urls: Readonly<Partial<Record<FaceDest, string>>>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly retryAfterMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
};

export const DECLARATION_TTL_MS = 60_000;
export const DECLARATION_RETRY_AFTER_MS = 15_000;
export const DECLARATION_TIMEOUT_MS = 5_000;
export const DECLARATION_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

type Entry = { readonly body: unknown; readonly etag: string | null; readonly checkedAt: number };

class DeclarationFetchError extends Error {
  override readonly name = "DeclarationFetchError";
}

/** 本文を上限まで読む。超えたら読むのをやめて null。 */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class FetchedDeclarations implements DeclarationSource {
  private readonly cache = new Map<FaceDest, Entry>();
  private readonly failedAt = new Map<FaceDest, number>();
  private readonly pending = new Map<FaceDest, Promise<unknown>>();
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: FetchedDeclarationsOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async get(handle: string): Promise<unknown> {
    if (!isFaceDest(handle)) return null;
    const url = this.options.urls[handle];
    if (!url) return null;
    const now = this.now();
    const entry = this.cache.get(handle);
    if (entry && now - entry.checkedAt < (this.options.ttlMs ?? DECLARATION_TTL_MS)) return structuredClone(entry.body);
    const failed = this.failedAt.get(handle);
    if (failed !== undefined && now - failed < (this.options.retryAfterMs ?? DECLARATION_RETRY_AFTER_MS)) return null;
    let running = this.pending.get(handle);
    if (!running) {
      running = this.refresh(handle, url, entry).finally(() => this.pending.delete(handle));
      this.pending.set(handle, running);
    }
    const body = await running;
    return body === null ? null : structuredClone(body);
  }

  private async refresh(handle: FaceDest, url: string, entry: Entry | undefined): Promise<unknown> {
    try {
      const signal = AbortSignal.timeout(this.options.timeoutMs ?? DECLARATION_TIMEOUT_MS);
      const response = await this.request(url, entry?.etag ?? null, signal);
      if (response.status === 304 && entry) {
        await response.body?.cancel().catch(() => undefined);
        this.remember(handle, { ...entry, checkedAt: this.now() });
        return entry.body;
      }
      if (response.status !== 200 || !JSON_TYPE.test(response.headers.get("content-type") ?? "")) throw new DeclarationFetchError();
      const text = await readLimited(response, this.options.maxBytes ?? DECLARATION_MAX_BYTES);
      if (text === null) throw new DeclarationFetchError();
      const body: unknown = JSON.parse(text);
      this.remember(handle, { body, etag: response.headers.get("etag"), checkedAt: this.now() });
      return body;
    } catch {
      // 前に読めた宣言も使わない（古い条件で公開を通さない）。ETag も捨てて、次は取り直す
      this.cache.delete(handle);
      this.failedAt.set(handle, this.now());
      return null;
    }
  }

  private remember(handle: FaceDest, entry: Entry): void {
    this.cache.set(handle, entry);
    this.failedAt.delete(handle);
  }

  /** 同じ host の https への redirect だけを追う。 */
  private async request(url: string, etag: string | null, signal: AbortSignal): Promise<Response> {
    let current = new URL(url);
    const host = current.host;
    for (let hop = 0; ; hop += 1) {
      const headers: Record<string, string> = { accept: "application/json" };
      if (etag) headers["if-none-match"] = etag;
      const response = await this.fetch(current.toString(), { method: "GET", headers, redirect: "manual", signal, credentials: "omit", cache: "no-store" });
      if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (location === null || hop >= MAX_REDIRECTS) throw new DeclarationFetchError();
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.host !== host || next.username !== "" || next.password !== "") throw new DeclarationFetchError();
      current = next;
    }
  }
}
