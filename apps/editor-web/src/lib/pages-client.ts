/** ブラウザから `/api/pages` を呼ぶ（同じ origin。cookie・token は扱わない）。 */

import type { PageChunk } from "@niho/editor-store";
import { PAGE_CHUNK } from "./page-limits";

export type PageBody = {
  title?: string;
  blocks?: unknown[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PageRequestError extends Error {
  override readonly name = "PageRequestError";
  constructor(readonly status: number) {
    super(`page request failed with ${status}`);
  }
}

async function send(path: string, method: "POST" | "PATCH", body: PageBody): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new PageRequestError(response.status);
  return response.json();
}

/** 新しいページを作り（題名・本文を渡せば、それで作る）、その id を返す。 */
export async function createPageRequest(body: PageBody = {}): Promise<string> {
  const data = (await send("/api/pages", "POST", body)) as { page?: { id?: unknown } };
  const id = data.page?.id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new PageRequestError(500);
  return id;
}

/** ページの部分更新。 */
export async function savePageRequest(id: string, body: PageBody): Promise<void> {
  await send(`/api/pages/${encodeURIComponent(id)}`, "PATCH", body);
}

/** 一覧の続き（cursor は前の応答の next）。 */
export async function listPagesRequest(cursor: string): Promise<PageChunk> {
  const response = await fetch(`/api/pages?limit=${PAGE_CHUNK}&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageRequestError(response.status);
  const data = (await response.json()) as { pages?: unknown; next?: unknown };
  if (!Array.isArray(data.pages) || (data.next !== null && typeof data.next !== "string")) throw new PageRequestError(500);
  return { pages: data.pages as PageChunk["pages"], next: data.next };
}
