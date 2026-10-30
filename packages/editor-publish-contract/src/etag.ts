/**
 * Canonical JSON and strong ETags. A 200 carries `"<sha256 hex of canonical JSON>"`.
 * Errors never include the offending value.
 */

import { sha256Hex } from "./runtime.js";

export { sha256Hex };

/**
 * JSON with object keys sorted (UTF-16 code unit order), no whitespace and
 * undefined properties omitted. Throws on NaN / Infinity, undefined array
 * entries, cycles and non-JSON values.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError("canonicalJson: unsupported value");
  }
  const object = value as object;
  if (ancestors.has(object)) throw new TypeError("canonicalJson: cycle");
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((entry: unknown) => {
        if (entry === undefined) throw new TypeError("canonicalJson: undefined array entry");
        return serialize(entry, ancestors);
      }).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonicalJson: unsupported value");
    const record = object as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

/** UTF-8 byte length (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Strong ETag of the canonical JSON of `value`. */
export async function computeEtag(value: unknown): Promise<string> {
  return `"${await sha256Hex(canonicalJson(value))}"`;
}

/**
 * RFC 9110 If-None-Match (weak comparison): `*`, a list of entity tags, `W/`
 * prefixes. A malformed header never matches, so the caller sends the full 200.
 */
export function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) return false;
  const target = opaqueTag(etag);
  if (target === null) return false;
  const value = header.trim();
  if (value === "*") return true;
  const tags: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === " " || value[index] === "\t" || value[index] === ",")) index += 1;
    if (index >= value.length) break;
    if (value.startsWith("W/", index)) index += 2;
    if (value[index] !== "\"") return false;
    const close = value.indexOf("\"", index + 1);
    if (close === -1) return false;
    const tag = value.slice(index, close + 1);
    if (!ENTITY_TAG.test(tag)) return false;
    tags.push(tag);
    index = close + 1;
    while (index < value.length && (value[index] === " " || value[index] === "\t")) index += 1;
    if (index < value.length && value[index] !== ",") return false;
  }
  return tags.includes(target);
}

const ENTITY_TAG = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

function opaqueTag(etag: string): string | null {
  const tag = etag.startsWith("W/") ? etag.slice(2) : etag;
  return ENTITY_TAG.test(tag) ? tag : null;
}
