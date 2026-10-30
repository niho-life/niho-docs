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

/**
 * The first of `base`, `base-2`, `base-3`, … that is valid (not reserved, within length) and not in
 * `taken`. Null when `base` itself is not slug-shaped.
 */
export function suggestSlug(base: string, taken: Iterable<string>): string | null {
  if (!SLUG_PATTERN.test(base)) return null;
  const used = new Set(taken);
  const fits = (candidate: string): boolean => validateSlug(candidate).ok && !used.has(candidate);
  const head = base.length > SLUG_MAX_LENGTH ? trimHyphens(base.slice(0, SLUG_MAX_LENGTH)) : base;
  if (fits(head)) return head;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${trimHyphens(head.slice(0, SLUG_MAX_LENGTH - suffix.length))}${suffix}`;
    if (fits(candidate)) return candidate;
  }
}
