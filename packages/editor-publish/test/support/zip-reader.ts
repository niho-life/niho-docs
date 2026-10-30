/** A minimal, independent ZIP reader for the tests (STORE only, no ZIP64, no data descriptors). */

import { crc32 as zlibCrc32 } from "node:zlib";

export interface ReadEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly time: number;
  readonly date: number;
}

/** Reads a ZIP without comments, ZIP64 or data descriptors, checking every header against the central directory. */
export function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 8, true) !== count) throw new Error("multi-disk");
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (at + size !== end) throw new Error("central directory does not end at the end record");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;

    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("bad local header");
    if (view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) throw new Error("local / central mismatch");
    if (view.getUint32(offset + 14, true) !== crc || view.getUint32(offset + 18, true) !== compressed || view.getUint32(offset + 22, true) !== uncompressed) {
      throw new Error("local / central size mismatch");
    }
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    if (decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName)) !== name) throw new Error("local / central name mismatch");
    const start = offset + 30 + localName + localExtra;
    const data = bytes.slice(start, start + compressed);
    if (method !== 0 || compressed !== uncompressed) throw new Error("not stored");
    if (zlibCrc32(data) !== crc) throw new Error("crc mismatch");
    entries.push({ name, data, flags, method, crc, time, date });
  }
  return entries;
}
