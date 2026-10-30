/**
 * URL predicates shared by the validator and the Markdown checker.
 * Allow-list only: anything not clearly safe is rejected.
 */

import { parseUrl } from "./runtime.js";

const SITE_BASE = "https://site.invalid";
// HTML / Markdown entity references are decoded by Markdown parsers (`&#47;` -> `/`).
const ENTITY_LIKE = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/;

/** Printable ASCII without quotes, angle brackets, backticks, backslashes or broken escapes. */
function hasSafeCharacters(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value)
    && !/[<>"'`\\]/.test(value)
    && !/%(?![0-9A-Fa-f]{2})/.test(value)
    && !ENTITY_LIKE.test(value);
}

/** Absolute `https:` URL with a host and no credentials. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !hasSafeCharacters(value) || !value.startsWith("https://")) return false;
  const authority = value.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
  if (authority === "" || authority.includes("@")) return false;
  let url: ReturnType<typeof parseUrl>;
  try {
    url = parseUrl(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
}

/** Path on the destination site: starts with a single `/` and stays on the same origin. */
export function isSitePath(value: unknown): value is string {
  if (typeof value !== "string" || !hasSafeCharacters(value)) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return parseUrl(value, SITE_BASE).origin === SITE_BASE;
  } catch {
    return false;
  }
}

/** Link targets: an https URL or a site path. */
export function isSafeLinkHref(value: unknown): value is string {
  return isHttpsUrl(value) || isSitePath(value);
}
