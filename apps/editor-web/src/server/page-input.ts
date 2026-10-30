import { isLanguage } from "@niho/docs-core";
import { PAGE_KINDS, type Block, type CreatePageInput, type PageKind, type PagePatch } from "@niho/editor-store";

/** 題名の上限（文字数。DB の CHECK と同じ）。 */
export const MAX_TITLE_CHARS = 500;
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
 * 本文。ここで見るのは「ブロック（type を持つ object）の配列で、大きさと深さが上限の内側」だけ。
 * ブロックの形はエディタ（niho-docs-ui の TipTap の schema の JSON）が決める。限定 AST としての厳密な検証は #33。
 */
export function parseBlocks(value: unknown): InputResult<Block[]> {
  if (!Array.isArray(value)) return { ok: false };
  if (!value.every((block) => isPlainObject(block) && typeof block.type === "string" && block.type.length > 0)) return { ok: false };
  if (!depthWithin(value, MAX_BLOCK_DEPTH)) return { ok: false };
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BLOCKS_BYTES) return { ok: false };
  if (serialized.includes("\\u0000")) return { ok: false };
  return { ok: true, value: value as Block[] };
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
