import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../../src/markdown.js";
import { CONTRACT_VERSION, type Block, type Dest, type PublishedAsset } from "../../src/v1.js";
import type { DraftContent, PublishedSnapshot } from "../../test-support/reference-server.js";

export function readJson<T>(relativeToPackage: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../${relativeToPackage}`, import.meta.url)), "utf8")) as T;
}

export interface Rng {
  next(): number;
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32: deterministic, seedable. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * max);
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("pick from empty list");
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LAST_CHAR = "AEIMQUYcgkosw048";

/** Runtime-generated synthetic secret: prefix + canonical 256-bit base64url. */
export function syntheticSecret(rng: Rng, prefix: string): string {
  let body = "";
  for (let index = 0; index < 42; index += 1) body += BASE64URL[rng.int(64)];
  return `${prefix}${body}${LAST_CHAR[rng.int(16)]}`;
}

export const syntheticKey = (rng: Rng): string => syntheticSecret(rng, "ek_");
export const syntheticPreviewToken = (rng: Rng): string => syntheticSecret(rng, "pv_");
export const syntheticServiceToken = (rng: Rng): string => syntheticSecret(rng, "st_");

export function syntheticUuid(rng: Rng): string {
  const hex = (length: number): string => Array.from({ length }, () => "0123456789abcdef"[rng.int(16)]).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[rng.int(4)]}${hex(3)}-${hex(12)}`;
}

export function canonicalUrlFor(dest: Dest, slug: string): string {
  if (dest === "exp") return `https://exp.example.com/guides/${slug}`;
  if (dest === "niho") return `https://niho.example.com/article/${slug}`;
  return `https://owner.example.com/notes/${slug}`;
}

export interface SnapshotInput {
  readonly id: string;
  readonly dest: Dest;
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
  readonly version?: number;
  readonly body?: string;
  readonly canonicalUrl?: string;
  readonly assets?: readonly PublishedAsset[];
}

export function paragraphs(text: string): readonly Block[] {
  return [{ type: "paragraph", content: [{ type: "text", text }] }];
}

export function snapshot(input: SnapshotInput): PublishedSnapshot {
  const blocks = paragraphs(input.body ?? `Published body of ${input.slug}.`);
  const assets = input.assets ?? [];
  return {
    id: input.id,
    slug: input.slug,
    dest: input.dest,
    lang: "en",
    title: input.title,
    lead: null,
    cover: null,
    category: null,
    author: { name: "Example Author", handle: null, url: null },
    version: input.version ?? 1,
    publishedAt: input.publishedAt ?? input.updatedAt,
    updatedAt: input.updatedAt,
    canonicalUrl: input.canonicalUrl ?? canonicalUrlFor(input.dest, input.slug),
    extras: { app: false, news: false, xp: false },
    related: [],
    blocks,
    markdown: renderMarkdown(blocks, assets),
    assets,
    contractVersion: CONTRACT_VERSION,
  };
}

/** Draft text always carries DRAFT-ONLY so a leak is easy to detect. */
export function draftContent(slug: string, title = `DRAFT-ONLY ${slug}`): DraftContent {
  return {
    slug,
    lang: "en",
    title,
    lead: "DRAFT-ONLY lead",
    cover: null,
    category: null,
    author: { name: "Example Author", handle: null, url: null },
    range: "live",
    canonicalUrl: `https://owner.example.com/notes/${slug}`,
    extras: { app: false, news: false, xp: false },
    related: [],
    blocks: paragraphs("DRAFT-ONLY body that has not been published."),
    assets: [],
  };
}

export function minutesFrom(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
