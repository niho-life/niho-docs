/**
 * ブラウザから「…」の操作（リンクで共有・複製・書き出し）の API を呼ぶ（同じ origin。cookie・token は扱わない）。
 * 画面への組み込みは #32（docs-ui の PageSharingPanel に DocsPageShareState をそのまま渡せる）。
 */
import type { DocsPageShareState } from "@niho/docs-core";

export type { DocsPageShareState };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PageActionError extends Error {
  override readonly name = "PageActionError";
  constructor(readonly status: number) {
    super(`page action failed with ${status}`);
  }
}

function pagePath(id: string, suffix: string): string {
  return `/api/pages/${encodeURIComponent(id)}${suffix}`;
}

const nullableString = (value: unknown) => value === null || typeof value === "string";

function isShareState(value: unknown): value is DocsPageShareState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state.status !== "PRIVATE" && state.status !== "PUBLIC") return false;
  if (!nullableString(state.publicId) || !nullableString(state.url) || !nullableString(state.updatedAt)) return false;
  return state.status === "PUBLIC" || (state.publicId === null && state.url === null);
}

async function send(path: string, method: "GET" | "PUT" | "POST" | "DELETE"): Promise<unknown> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageActionError(response.status);
  return response.json();
}

async function shareRequest(id: string, method: "GET" | "PUT" | "POST" | "DELETE", suffix = ""): Promise<DocsPageShareState> {
  const data = (await send(pagePath(id, `/share${suffix}`), method)) as { share?: unknown };
  if (!isShareState(data.share)) throw new PageActionError(500);
  const { status, publicId, url, updatedAt } = data.share;
  return { status, publicId, url, updatedAt };
}

/** 共有の状態を読む。 */
export function getPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "GET");
}

/** 共有を始める（共有中なら同じリンクのまま）。 */
export function startPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "PUT");
}

/** リンクを作り直す（今のリンクでは見られなくなる）。 */
export function rotatePageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "POST", "/rotate");
}

/** 共有を止める（すぐ見られなくなる）。 */
export function stopPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "DELETE");
}

/** ページを複製し、新しいページの id を返す。 */
export async function duplicatePageRequest(id: string): Promise<string> {
  const data = (await send(pagePath(id, "/duplicate"), "POST")) as { page?: { id?: unknown } };
  const newId = data.page?.id;
  if (typeof newId !== "string" || !UUID_PATTERN.test(newId)) throw new PageActionError(500);
  return newId;
}

/** Markdown の書き出しの URL（`<a href download>` か location に渡す。応答は attachment）。 */
export function pageExportUrl(id: string): string {
  return pagePath(id, "/export.md");
}
