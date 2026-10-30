/**
 * 書き出し (#41): Markdown + photos as a STORE-only zip.
 *
 * - One `{slug}.md` per page: a YAML front matter (title, lang, publishedAt, updatedAt, every value a
 *   double-quoted, escaped YAML string) and the body projected with the contract's `renderMarkdown`,
 *   photos pointing at `photos/{sha256}.{ext}` (relative to the file).
 * - Photos are de-duplicated by sha256. Their bytes are checked against `bytes` and `sha256`; a photo
 *   that is missing or does not match is never put in silently: the whole export fails and says which.
 * - Two pages with the same slug never overwrite each other (`slug.md`, `slug-2.md`, …).
 * - The Markdown must stay in the contract's subset (`checkMarkdownSubset`). The only finding allowed is
 *   `unsafe-image` on a standalone image line whose source is one of the archive's own `photos/…`
 *   paths: the checker accepts absolute https image sources only, and a relative path is the point of
 *   an export. Anything else fails the export.
 * - Results carry ids and reasons only, never page text.
 */

import {
  IMAGE_CONTENT_TYPES,
  LANGS,
  SHA256_PATTERN,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  TIMESTAMP_PATTERN,
  UUID_PATTERN,
  checkMarkdownSubset,
  renderMarkdown,
  type ImageContentType,
  type MarkdownViolation,
  type PublishedAsset,
  type PublishedDoc,
} from "@niho/editor-publish-contract";
import { sha256HexOfBytes, utf8 } from "./runtime.js";
import { buildZip, type ZipEntry, type ZipFailure } from "./zip.js";

export const PHOTO_EXTENSIONS: { readonly [K in ImageContentType]: string } = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const PHOTO_DIRECTORY = "photos" as const;

/** What the export needs from a published version (a `Snapshot` is one). */
export type ExportDoc = Pick<PublishedDoc, "id" | "slug" | "lang" | "title" | "publishedAt" | "updatedAt" | "blocks" | "assets">;

export interface ExportInput {
  /** The last published version of each page. */
  readonly docs: readonly ExportDoc[];
  /** Photo bytes by sha256, as read from the asset store. A missing entry means it could not be read. */
  readonly photos: ReadonlyMap<string, Uint8Array>;
}

export type ExportAssetProblem = "missing" | "size" | "digest";

export interface ExportAssetIssue {
  readonly pageId: string;
  readonly assetId: string;
  readonly problem: ExportAssetProblem;
}

export type ExportArchiveFailure =
  /** A version is not shaped like a published version (bad slug, timestamps, asset metadata …). */
  | { readonly ok: false; readonly reason: "invalid_page"; readonly pageId: string | null }
  | { readonly ok: false; readonly reason: "asset_invalid"; readonly assets: readonly ExportAssetIssue[] }
  | { readonly ok: false; readonly reason: "markdown_invalid"; readonly pageId: string }
  | { readonly ok: false; readonly reason: "archive_invalid"; readonly zip: ZipFailure["reason"] };

export interface ExportArchive {
  readonly ok: true;
  readonly bytes: Uint8Array;
  /** Archive paths, in archive order. */
  readonly files: readonly string[];
  readonly pages: number;
  readonly photos: number;
}

export type ExportArchiveResult = ExportArchive | ExportArchiveFailure;

const PHOTO_LINE = new RegExp(
  `^!\\[(?:[^\\]\\\\]|\\\\.)*\\]\\((${PHOTO_DIRECTORY}/[0-9a-f]{64}\\.(?:${Object.values(PHOTO_EXTENSIONS).join("|")}))(?: "(?:[^"\\\\]|\\\\.)*")?\\)$`,
  "u",
);

function isPhotoContentType(value: unknown): value is ImageContentType {
  return typeof value === "string" && (IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

function validAsset(asset: unknown): asset is PublishedAsset {
  if (typeof asset !== "object" || asset === null) return false;
  const { id, sha256, contentType, bytes } = asset as Partial<Record<keyof PublishedAsset, unknown>>;
  return typeof id === "string" && id !== "" && typeof sha256 === "string" && SHA256_PATTERN.test(sha256)
    && isPhotoContentType(contentType) && typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
}

function validDoc(doc: unknown): doc is ExportDoc {
  if (typeof doc !== "object" || doc === null) return false;
  const { id, slug, lang, title, publishedAt, updatedAt, blocks, assets } = doc as Partial<Record<keyof ExportDoc, unknown>>;
  return typeof id === "string" && UUID_PATTERN.test(id)
    && typeof slug === "string" && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug)
    && typeof lang === "string" && (LANGS as readonly string[]).includes(lang)
    && typeof title === "string"
    && typeof publishedAt === "string" && TIMESTAMP_PATTERN.test(publishedAt)
    && typeof updatedAt === "string" && TIMESTAMP_PATTERN.test(updatedAt)
    && Array.isArray(blocks)
    && Array.isArray(assets) && assets.every(validAsset);
}

/** A YAML 1.2 double-quoted scalar. Quotes, backslashes, controls and line / paragraph separators are escaped. */
export function yamlString(value: string): string {
  let out = "\"";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\"") out += "\\\"";
    else if (char === "\\") out += "\\\\";
    else if (code >= 0xd800 && code <= 0xdfff) out += "\\ufffd";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return `${out}"`;
}

function frontMatter(doc: ExportDoc): string {
  return [
    "---",
    `title: ${yamlString(doc.title)}`,
    `lang: ${yamlString(doc.lang)}`,
    `publishedAt: ${yamlString(doc.publishedAt)}`,
    `updatedAt: ${yamlString(doc.updatedAt)}`,
    "---",
    "",
  ].join("\n");
}

/** Subset findings that are not the archive's own relative photo sources. */
function subsetViolations(markdown: string, photoPaths: ReadonlySet<string>): readonly MarkdownViolation[] {
  const lines = markdown.split("\n");
  return checkMarkdownSubset(markdown).filter((violation) => {
    if (violation.reason !== "unsafe-image") return true;
    const source = PHOTO_LINE.exec(lines[violation.line - 1] ?? "")?.[1];
    return source === undefined || !photoPaths.has(source);
  });
}

/** `{slug}.md`, then `{slug}-2.md`, `{slug}-3.md` … for later pages with the same slug (never overwritten). */
function fileNames(docs: readonly ExportDoc[]): readonly string[] {
  const names: (string | null)[] = docs.map(() => null);
  const used = new Set<string>();
  docs.forEach((doc, index) => {
    if (!used.has(doc.slug)) {
      used.add(doc.slug);
      names[index] = doc.slug;
    }
  });
  docs.forEach((doc, index) => {
    if (names[index] !== null) return;
    let n = 2;
    while (used.has(`${doc.slug}-${n}`)) n += 1;
    used.add(`${doc.slug}-${n}`);
    names[index] = `${doc.slug}-${n}`;
  });
  return names.map((name) => `${name as string}.md`);
}

/**
 * Builds the export zip. Deterministic: pages are ordered by slug then id, photos by path, and every
 * Markdown file carries its version's `updatedAt` as modification time.
 */
export async function buildExportArchive(input: ExportInput): Promise<ExportArchiveResult> {
  const given: readonly unknown[] = Array.isArray(input?.docs) ? input.docs : [];
  for (const doc of given) {
    if (!validDoc(doc)) {
      const id = (doc as { id?: unknown } | null)?.id;
      return { ok: false, reason: "invalid_page", pageId: typeof id === "string" && UUID_PATTERN.test(id) ? id : null };
    }
  }
  const docs = [...(given as readonly ExportDoc[])].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Photos: one file per sha256, checked against the published metadata of every asset that uses it.
  const pathBySha = new Map<string, string>();
  const digests = new Map<string, string>();
  const issues: ExportAssetIssue[] = [];
  for (const doc of docs) {
    for (const asset of doc.assets) {
      if (!pathBySha.has(asset.sha256)) pathBySha.set(asset.sha256, `${PHOTO_DIRECTORY}/${asset.sha256}.${PHOTO_EXTENSIONS[asset.contentType]}`);
      const data = input.photos.get(asset.sha256);
      if (!(data instanceof Uint8Array)) {
        issues.push({ pageId: doc.id, assetId: asset.id, problem: "missing" });
        continue;
      }
      if (data.byteLength !== asset.bytes) {
        issues.push({ pageId: doc.id, assetId: asset.id, problem: "size" });
        continue;
      }
      let digest = digests.get(asset.sha256);
      if (digest === undefined) {
        digest = await sha256HexOfBytes(data);
        digests.set(asset.sha256, digest);
      }
      if (digest !== asset.sha256) issues.push({ pageId: doc.id, assetId: asset.id, problem: "digest" });
    }
  }
  if (issues.length > 0) return { ok: false, reason: "asset_invalid", assets: issues };

  const photoPaths = new Set(pathBySha.values());
  const names = fileNames(docs);
  const entries: ZipEntry[] = [];
  for (const [index, doc] of docs.entries()) {
    const relative = doc.assets.map((asset) => ({ ...asset, url: pathBySha.get(asset.sha256) as string }));
    let markdown: string;
    try {
      markdown = renderMarkdown(doc.blocks, relative);
    } catch {
      return { ok: false, reason: "markdown_invalid", pageId: doc.id };
    }
    if (subsetViolations(markdown, photoPaths).length > 0) return { ok: false, reason: "markdown_invalid", pageId: doc.id };
    const text = markdown === "" ? frontMatter(doc) : `${frontMatter(doc)}\n${markdown}`;
    entries.push({ name: names[index] as string, data: utf8(text), modifiedAt: doc.updatedAt });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const photoEntries = [...pathBySha.entries()]
    .map(([sha, path]) => ({ name: path, data: input.photos.get(sha) as Uint8Array }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const all = [...entries, ...photoEntries];
  const zip = buildZip(all);
  if (!zip.ok) return { ok: false, reason: "archive_invalid", zip: zip.reason };
  return { ok: true, bytes: zip.bytes, files: all.map((entry) => entry.name), pages: entries.length, photos: photoEntries.length };
}
