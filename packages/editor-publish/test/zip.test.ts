/** #41 書き出し: the STORE-only zip writer, read back by an independent minimal reader. */

import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ZIP_LIMITS, buildZip, crc32, zipNameProblem, type ZipEntry } from "../src/index.js";
import { readZip } from "./support/zip-reader.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("buildZip", () => {
  const entries: ZipEntry[] = [
    { name: "a-walk.md", data: text("# title\n\nBody.\n"), modifiedAt: "2026-10-01T09:00:00.000Z" },
    { name: "写真/メモ.md", data: text("UTF-8 の名前") },
    { name: "photos/empty.png", data: new Uint8Array(0) },
    { name: "photos/bin.webp", data: Uint8Array.from({ length: 300 }, (_, index) => index % 256) },
  ];

  it("writes entries a reader can read back: names (UTF-8 flag), contents, CRC-32, STORE", () => {
    const result = buildZip(entries);
    if (!result.ok) throw new Error(result.reason);
    const read = readZip(result.bytes);
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    read.forEach((entry, index) => {
      const source = entries[index] as ZipEntry;
      expect(Array.from(entry.data)).toEqual(Array.from(source.data));
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(crc32(source.data));
    });
    expect(decode(read[1]?.data ?? new Uint8Array())).toBe("UTF-8 の名前");
    // 2026-10-01 09:00:00 UTC in DOS fields; entries without a time get 1980-01-01 00:00.
    expect([read[0]?.date, read[0]?.time]).toEqual([((2026 - 1980) << 9) | (10 << 5) | 1, 9 << 11]);
    expect([read[1]?.date, read[1]?.time]).toEqual([(1 << 5) | 1, 0]);
  });

  it("matches zlib's CRC-32", () => {
    for (const sample of [new Uint8Array(0), text("123456789"), Uint8Array.from({ length: 4096 }, (_, index) => (index * 31) % 256)]) {
      expect(crc32(sample)).toBe(zlibCrc32(sample));
    }
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
  });

  it("is deterministic: the same input gives the same bytes", () => {
    const first = buildZip(entries);
    const second = buildZip(entries.map((entry) => ({ ...entry, data: Uint8Array.from(entry.data) })));
    expect(first.ok && second.ok && Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
  });

  it("an empty archive is just the end record", () => {
    const result = buildZip([]);
    expect(result.ok && result.bytes.byteLength).toBe(22);
    expect(result.ok && readZip(result.bytes)).toEqual([]);
  });

  const SLIP: readonly [string, string][] = [
    ["../evil.md", "dot-segment"],
    ["photos/../../evil.md", "dot-segment"],
    ["./a.md", "dot-segment"],
    ["photos/..", "dot-segment"],
    ["/etc/evil", "absolute"],
    ["photos\\evil.md", "backslash"],
    ["..\\evil.md", "backslash"],
    ["C:/evil.md", "colon"],
    ["c:evil.md", "colon"],
    ["a.md:stream", "colon"],
    ["photos//a.md", "empty-segment"],
    ["photos/", "empty-segment"],
    ["", "empty"],
    ["a\u0000.md", "control-character"],
    ["a\n.md", "control-character"],
    ["a\u007f.md", "control-character"],
    [`a${String.fromCharCode(0x2028)}.md`, "control-character"],
    [`a${String.fromCharCode(0xd800)}.md`, "control-character"],
    [`${"a".repeat(70_000)}.md`, "too-long"],
  ];
  it.each(SLIP.map(([name, problem]) => [JSON.stringify(name.slice(0, 24)), name, problem] as const))("refuses the name %s", (_label, name, problem) => {
    expect(zipNameProblem(name)).toBe(problem);
    const result = buildZip([{ name: "ok.md", data: text("ok") }, { name, data: text("x") }]);
    expect(result).toEqual({ ok: false, reason: "name", index: 1, problem });
    expect(JSON.stringify(result)).not.toContain("evil");
  });

  it("refuses duplicates, also those a case-insensitive or normalizing file system would merge", () => {
    expect(buildZip([{ name: "a.md", data: text("1") }, { name: "a.md", data: text("2") }])).toEqual({ ok: false, reason: "duplicate", index: 1 });
    expect(buildZip([{ name: "A.md", data: text("1") }, { name: "a.md", data: text("2") }])).toEqual({ ok: false, reason: "duplicate", index: 1 });
    expect(buildZip([{ name: "caf\u00e9.md", data: text("1") }, { name: "cafe\u0301.md", data: text("2") }])).toEqual({ ok: false, reason: "duplicate", index: 1 });
  });

  it("refuses more than 65,535 entries (no ZIP64)", () => {
    const many = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${index}`, data: new Uint8Array(0) }));
    expect(buildZip(many)).toEqual({ ok: false, reason: "too-many-entries" });
  });

  it("accepts exactly 65,535 entries", () => {
    const many = Array.from({ length: ZIP_LIMITS.maxEntries }, (_, index) => ({ name: `f${index}`, data: new Uint8Array(0) }));
    const result = buildZip(many);
    expect(result.ok && readZip(result.bytes).length).toBe(ZIP_LIMITS.maxEntries);
  });

  it("refuses entries or archives of 4 GiB and more, before reading any bytes (no ZIP64)", () => {
    // Stand-ins that report a huge length; their bytes are never touched.
    const huge = (byteLength: number): Uint8Array => Object.create(Uint8Array.prototype, { byteLength: { value: byteLength } }) as Uint8Array;
    expect(buildZip([{ name: "big.bin", data: huge(2 ** 32) }])).toEqual({ ok: false, reason: "too-large" });
    expect(buildZip([{ name: "a.bin", data: huge(2 ** 31) }, { name: "b.bin", data: huge(2 ** 31) }])).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses entries that are not bytes", () => {
    expect(buildZip([{ name: "a.md", data: "text" as unknown as Uint8Array }])).toEqual({ ok: false, reason: "invalid-entry", index: 0 });
  });
});
