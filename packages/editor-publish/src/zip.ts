/**
 * A minimal, dependency-free ZIP writer (#41 書き出し): STORE only (no compression), CRC-32, UTF-8
 * names (general purpose bit 11), deterministic bytes for the same input.
 *
 * - Names are checked so that extracting the archive can never write outside its folder (no zip-slip):
 *   no `..` / `.` segment, no leading `/`, no `\`, no `:` (drive names, NTFS streams), no control
 *   characters, no empty segment, no duplicates (compared case-insensitively after NFC, as file
 *   systems do). Rejections are results with a reason, never exceptions, and never echo the name.
 * - ZIP64 is not supported: more than 65,535 entries, or any size / offset that does not fit in 32
 *   bits (about 4 GiB), is rejected before anything is written.
 */

import { utf8 } from "./runtime.js";

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  readonly name: string;
  readonly data: Uint8Array;
  /** ISO 8601 UTC. Omitted: 1980-01-01T00:00:00Z (the DOS epoch), so archives stay deterministic. */
  readonly modifiedAt?: string;
}

export const ZIP_LIMITS = {
  maxEntries: 0xffff,
  /** Every 32-bit size and offset must stay below the ZIP64 sentinel 0xFFFFFFFF. */
  maxBytes: 0xfffffffe,
  maxNameBytes: 0xffff,
} as const;

export type ZipNameProblem = "empty" | "absolute" | "backslash" | "colon" | "control-character" | "empty-segment" | "dot-segment" | "too-long";

export type ZipFailure =
  | { readonly ok: false; readonly reason: "name"; readonly index: number; readonly problem: ZipNameProblem }
  | { readonly ok: false; readonly reason: "duplicate"; readonly index: number }
  | { readonly ok: false; readonly reason: "too-many-entries" }
  | { readonly ok: false; readonly reason: "too-large" }
  | { readonly ok: false; readonly reason: "invalid-entry"; readonly index: number };

export type ZipResult = { readonly ok: true; readonly bytes: Uint8Array } | ZipFailure;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]|\p{Cs}/u;

/** Why `name` cannot be an archive path, or null when it can. */
export function zipNameProblem(name: unknown): ZipNameProblem | null {
  if (typeof name !== "string" || name === "") return "empty";
  if (CONTROL.test(name)) return "control-character";
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute";
  if (name.includes(":")) return "colon";
  for (const segment of name.split("/")) {
    if (segment === "") return "empty-segment";
    if (segment === "." || segment === "..") return "dot-segment";
  }
  if (utf8(name).length > ZIP_LIMITS.maxNameBytes) return "too-long";
  return null;
}

// --- CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) ---------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- DOS time ------------------------------------------------------------------------

const DOS_EPOCH = { time: 0, date: (0 << 9) | (1 << 5) | 1 } as const;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/** DOS date / time fields (UTC, 2-second resolution). Outside 1980–2107 or malformed: the DOS epoch. */
function dosTime(iso: string | undefined): { readonly time: number; readonly date: number } {
  if (iso === undefined) return DOS_EPOCH;
  const match = ISO_UTC.exec(iso);
  if (!match || Number.isNaN(Date.parse(iso))) return DOS_EPOCH;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  if (year < 1980 || year > 2107) return DOS_EPOCH;
  return {
    time: (hour << 11) | (minute << 5) | Math.floor(second / 2),
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

// --- writer --------------------------------------------------------------------------

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_OF_CENTRAL_DIRECTORY = 22;
const VERSION_MADE_BY = (3 << 8) | 63; // Unix, APPNOTE 6.3 (defines the UTF-8 flag)
const VERSION_NEEDED = 10; // STORE
const FLAG_UTF8 = 0x0800;
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0; // regular file, rw-r--r--

interface Prepared {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly time: number;
  readonly date: number;
  readonly offset: number;
}

/**
 * Builds a STORE-only ZIP of `entries`, in the given order. Every check (names, duplicates, counts,
 * sizes) runs before any byte is produced.
 */
export function buildZip(entries: readonly ZipEntry[]): ZipResult {
  if (!Array.isArray(entries)) return { ok: false, reason: "invalid-entry", index: 0 };
  if (entries.length > ZIP_LIMITS.maxEntries) return { ok: false, reason: "too-many-entries" };

  // Sizes first: a huge entry is refused before its bytes are read.
  let total = END_OF_CENTRAL_DIRECTORY;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || !(entry.data instanceof Uint8Array)) {
      return { ok: false, reason: "invalid-entry", index };
    }
    const length = entry.data.byteLength;
    if (!Number.isSafeInteger(length) || length > ZIP_LIMITS.maxBytes) return { ok: false, reason: "too-large" };
    total += LOCAL_HEADER + CENTRAL_HEADER + length;
    if (total > ZIP_LIMITS.maxBytes) return { ok: false, reason: "too-large" };
  }

  const seen = new Set<string>();
  const names: Uint8Array[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as ZipEntry;
    const problem = zipNameProblem(entry.name);
    if (problem !== null) return { ok: false, reason: "name", index, problem };
    const key = entry.name.normalize("NFC").toLowerCase();
    if (seen.has(key)) return { ok: false, reason: "duplicate", index };
    seen.add(key);
    const name = utf8(entry.name);
    total += 2 * name.length;
    if (total > ZIP_LIMITS.maxBytes) return { ok: false, reason: "too-large" };
    names.push(name);
  }

  const prepared: Prepared[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = names[index] as Uint8Array;
    const { time, date } = dosTime(entry.modifiedAt);
    prepared.push({ name, data: entry.data, crc: crc32(entry.data), time, date, offset });
    offset += LOCAL_HEADER + name.length + entry.data.byteLength;
  });

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number): void => {
    view.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number): void => {
    view.setUint32(at, value >>> 0, true);
    at += 4;
  };
  const bytes = (value: Uint8Array): void => {
    out.set(value, at);
    at += value.length;
  };

  for (const entry of prepared) {
    u32(0x04034b50);
    u16(VERSION_NEEDED);
    u16(FLAG_UTF8);
    u16(0); // STORE
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    u32(entry.data.byteLength);
    u32(entry.data.byteLength);
    u16(entry.name.length);
    u16(0); // extra
    bytes(entry.name);
    bytes(entry.data);
  }

  const centralOffset = at;
  for (const entry of prepared) {
    u32(0x02014b50);
    u16(VERSION_MADE_BY);
    u16(VERSION_NEEDED);
    u16(FLAG_UTF8);
    u16(0);
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    u32(entry.data.byteLength);
    u32(entry.data.byteLength);
    u16(entry.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(EXTERNAL_ATTRIBUTES);
    u32(entry.offset);
    bytes(entry.name);
  }
  const centralSize = at - centralOffset;

  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSize);
  u32(centralOffset);
  u16(0); // comment
  return { ok: true, bytes: out };
}
