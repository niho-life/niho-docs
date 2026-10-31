/**
 * ブラウザから「…」の操作（リンクで共有・複製・書き出し・削除）の API を呼ぶ（同じ origin。cookie・token は扱わない）。
 * 複製・書き出し・削除はヘッダーの「…」（src/lib/use-page-menu.ts）から。共有は次の段（docs-ui の PageSharingPanel に
 * DocsPageShareState をそのまま渡せる）。
 */
import type { DocsPageShareState } from "@niho/docs-core";
import type { PageKind } from "@niho/editor-store";

export type { DocsPageShareState };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** editor-store の PAGE_KINDS の写し（画面に pg を持ち込まないよう、値は import しない）。 */
const PAGE_KINDS = ["note", "rec", "article", "step"] as const satisfies readonly PageKind[];

export class PageActionError extends Error {
  override readonly name = "PageActionError";
  /** `code` はエラーの本文の短い code（`published` など。読めなければ null）。 */
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
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

/** 複製してできたページ（一覧の上に足すのに要る分）。 */
export type DuplicatedPage = { id: string; title: string; kind: PageKind };

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** ページを複製し、新しいページの id・題名（「〜のコピー」）・種類を返す。種類が読めなければ note として扱う。 */
export async function duplicatePageRequest(id: string): Promise<DuplicatedPage> {
  const data = (await send(pagePath(id, "/duplicate"), "POST")) as { page?: { id?: unknown; title?: unknown; kind?: unknown } };
  const newId = data.page?.id;
  const title = data.page?.title;
  if (typeof newId !== "string" || !UUID_PATTERN.test(newId) || typeof title !== "string") throw new PageActionError(500);
  const kind = data.page?.kind;
  return { id: newId, title, kind: isPageKind(kind) ? kind : "note" };
}

/** Markdown の書き出しの URL（`<a href download>` か location に渡す。応答は attachment）。 */
export function pageExportUrl(id: string): string {
  return pagePath(id, "/export.md");
}

/** 削除の応答を待つ上限（届かないまま待ち続けて、確認のダイアログが閉じられなくならないように）。 */
export const DELETE_TIMEOUT_MS = 30_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/**
 * ページをゴミ箱へ入れる（`DELETE /api/pages/{id}`。204。子孫のページもサーバーが一緒に入れる）。
 * 失敗は PageActionError（公開中は 409 と code `published`）。届かない・時間切れは fetch の例外のまま。
 */
export async function deletePageRequest(id: string): Promise<void> {
  const signal = timeoutSignal(DELETE_TIMEOUT_MS);
  const response = await fetch(pagePath(id, ""), { method: "DELETE", credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  throw new PageActionError(response.status, typeof body?.error === "string" ? body.error : null);
}
