/**
 * URL slugs (#39). A slug can change until the first publication and is fixed afterwards;
 * re-publishing after "公開をやめる" uses the same slug and URL.
 */

import { SLUG_MAX_LENGTH, SLUG_PATTERN } from "@niho/editor-publish-contract";

export const SLUG_FROM_TITLE_MAX = 80;

export const RESERVED_SLUGS = [
  "index",
  "new",
  "edit",
  "preview",
  "tag",
  "tags",
  "category",
  "categories",
  "page",
  "feed",
  "rss",
  "sitemap",
  "api",
  "admin",
] as const;

export type SlugError = "format" | "length" | "reserved";

export type SlugCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SlugError };

export function isReservedSlug(slug: string): boolean {
  return (RESERVED_SLUGS as readonly string[]).includes(slug);
}

export function validateSlug(slug: unknown): SlugCheck {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return { ok: false, reason: "format" };
  if (slug.length > SLUG_MAX_LENGTH) return { ok: false, reason: "length" };
  if (isReservedSlug(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

function trimHyphens(text: string): string {
  return text.replace(/^-+|-+$/g, "");
}

/**
 * NFKC → lowercase → ASCII letters, digits and single hyphens → at most 80 characters.
 * A title with no ASCII letter or digit left (Japanese, for example) becomes `p-` + the first 8
 * characters of the page id. The result matches the slug pattern but may be a reserved word;
 * pass it through `suggestSlug` before use.
 */
export function slugFromTitle(title: string, pageId: string): string {
  const base = trimHyphens(title.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  const cut = trimHyphens(base.slice(0, SLUG_FROM_TITLE_MAX));
  if (cut !== "") return cut;
  const id = pageId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return id === "" ? "p" : `p-${id}`;
}

/** Room kept for a `-N` suffix (up to `-9999`), so every numbered candidate shares one stem. */
const SUFFIX_RESERVE = 5;

/**
 * The part of `base` that numbered candidates (`stem-2`, `stem-3`, …) start with: `base` itself when it
 * leaves room for a suffix, otherwise its first characters. A store must report the slugs taken under
 * the stem as well as under `base` (`takenSlugs(handle, stem, …)`) for `suggestSlug` to see them.
 */
export function slugStem(base: string): string {
  return base.length > SLUG_MAX_LENGTH - SUFFIX_RESERVE ? trimHyphens(base.slice(0, SLUG_MAX_LENGTH - SUFFIX_RESERVE)) : base;
}

/**
 * The first of `base`, `stem-2`, `stem-3`, … that is valid (not reserved, within length) and not in
 * `taken`. Null when `base` itself is not slug-shaped, or when nothing up to `-9999` is free.
 */
export function suggestSlug(base: string, taken: Iterable<string>): string | null {
  if (!SLUG_PATTERN.test(base)) return null;
  const used = new Set(taken);
  const fits = (candidate: string): boolean => validateSlug(candidate).ok && !used.has(candidate);
  if (fits(base)) return base;
  const stem = slugStem(base);
  if (stem === "") return null;
  for (let n = 2; n <= 9999; n += 1) {
    const candidate = `${stem}-${n}`;
    if (fits(candidate)) return candidate;
  }
  return null;
}
