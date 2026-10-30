import { isLanguage } from "@niho/docs-core";
import { PAGE_KINDS, isPositiveInteger, type Block, type CreatePageInput, type PageKind, type PagePatch } from "@niho/editor-store";
import { validateBlocks } from "../ast/blocks";

import { MAX_TITLE_CHARS } from "../lib/page-limits";

export { MAX_TITLE_CHARS };
/** 本文（blocks の JSON）の上限。要求の本文の上限（1 MiB）の内側に収まる値にする。 */
export const MAX_BLOCKS_BYTES = 1000 * 1024;
/** 本文の入れ子の深さの上限（深すぎる JSON で DB・描画を詰まらせない）。 */
export const MAX_BLOCK_DEPTH = 64;

const ALLOWED_KEYS = new Set(["kind", "title", "lang", "blocks"]);

export type InputResult<T> = { ok: true; value: T } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** NUL は PostgreSQL の text・jsonb に入らないので、入口で断る。 */
function hasNul(text: string): boolean {
  return text.includes("\u0000");
}

function depthWithin(value: unknown, limit: number): boolean {
  if (limit < 0) return false;
  if (Array.isArray(value)) return value.every((item) => depthWithin(item, limit - 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => depthWithin(item, limit - 1));
  return true;
}

function parseTitle(value: unknown): InputResult<string> {
  if (typeof value !== "string" || hasNul(value)) return { ok: false };
  if (Array.from(value).length > MAX_TITLE_CHARS) return { ok: false };
  return { ok: true, value };
}

/**
 * 本文。大きさ・深さ・NUL を見たあと、限定 AST（src/ast/blocks.ts）として保存してよいかを検査する。
 * 返すのは入力そのものではなく、許す形だけで組み直した写し。
 */
export function parseBlocks(value: unknown): InputResult<Block[]> {
  if (!Array.isArray(value)) return { ok: false };
  if (!depthWithin(value, MAX_BLOCK_DEPTH)) return { ok: false };
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BLOCKS_BYTES) return { ok: false };
  if (serialized.includes("\\u0000")) return { ok: false };
  const checked = validateBlocks(value);
  return checked.ok ? { ok: true, value: checked.blocks } : { ok: false };
}

function parseFields(body: unknown): InputResult<PagePatch> {
  if (!isPlainObject(body)) return { ok: false };
  if (!Object.keys(body).every((key) => ALLOWED_KEYS.has(key))) return { ok: false };
  const result: PagePatch = {};
  if (body.kind !== undefined) {
    if (!isPageKind(body.kind)) return { ok: false };
    result.kind = body.kind;
  }
  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (!title.ok) return { ok: false };
    result.title = title.value;
  }
  if (body.lang !== undefined) {
    // 言語の値の範囲は docs-core（NIHO docs の中核）と同じ ja | en
    if (!isLanguage(body.lang)) return { ok: false };
    result.lang = body.lang;
  }
  if (body.blocks !== undefined) {
    const blocks = parseBlocks(body.blocks);
    if (!blocks.ok) return { ok: false };
    result.blocks = blocks.value;
  }
  return { ok: true, value: result };
}

/** 新しいページ。全て任意（`{}` で空のページ）。 */
export function parseCreatePage(body: unknown): InputResult<CreatePageInput> {
  return parseFields(body);
}

/** 部分更新。少なくとも 1 つは指定する。 */
export function parsePagePatch(body: unknown): InputResult<PagePatch> {
  const parsed = parseFields(body);
  if (!parsed.ok || Object.keys(parsed.value).length === 0) return { ok: false };
  return parsed;
}

/** PATCH /api/pages/{id} の本文。`baseRevision` は必須（楽観ロック）。`overwrite` は「この内容で上書き」。 */
export type PageSave = { patch: PagePatch; baseRevision: number; overwrite: boolean };

/** 部分更新の欄に、`baseRevision`（正の整数・必須）と `overwrite`（真偽・任意）を足したもの。 */
export function parsePageSave(body: unknown): InputResult<PageSave> {
  if (!isPlainObject(body)) return { ok: false };
  const { baseRevision, overwrite, ...fields } = body;
  if (!isPositiveInteger(baseRevision)) return { ok: false };
  if (overwrite !== undefined && typeof overwrite !== "boolean") return { ok: false };
  const patch = parsePagePatch(fields);
  if (!patch.ok) return { ok: false };
  return { ok: true, value: { patch: patch.value, baseRevision, overwrite: overwrite === true } };
}

/** POST /api/pages/{id}/versions/{n}/restore の本文（`baseRevision` だけ）。 */
export function parseRestoreBody(body: unknown): InputResult<{ baseRevision: number }> {
  if (!isPlainObject(body)) return { ok: false };
  if (!Object.keys(body).every((key) => key === "baseRevision")) return { ok: false };
  return isPositiveInteger(body.baseRevision) ? { ok: true, value: { baseRevision: body.baseRevision } } : { ok: false };
}

/** URL の版の番号（`1` 以上の 10 進の整数だけ。`01`・`1.0`・`+1` は受けない）。正しくなければ null（ページの 404 と同じに扱う）。 */
export function parseVersionNumber(value: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const version = Number(value);
  return isPositiveInteger(version) ? version : null;
}
