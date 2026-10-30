import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, computeEtag, ifNoneMatchMatches, utf8ByteLength } from "../src/etag.js";

describe("canonicalJson", () => {
  it("sorts keys, drops whitespace and undefined properties", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined, d: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"d":{"y":0,"z":0}}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson("é\u2028")).toBe(JSON.stringify("é\u2028"));
    expect(canonicalJson({ "é": 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it("rejects values JSON cannot carry, without echoing them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, [undefined], cyclic, new Date(0), 1n, () => 1, Symbol("s")]) {
      expect(() => canonicalJson(value)).toThrow(/^canonicalJson: [a-z -]+$/);
    }
  });

  it("counts UTF-8 bytes", () => {
    expect(utf8ByteLength("aé朝😀")).toBe(1 + 2 + 3 + 4);
  });
});

describe("ETag", () => {
  it("is the strong SHA-256 of the canonical JSON", async () => {
    const value = { b: [1, 2], a: "朝" };
    const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    expect(await computeEtag(value)).toBe(`"${expected}"`);
    expect(await computeEtag({ a: "朝", b: [1, 2] })).toBe(await computeEtag(value));
    expect(await computeEtag({ a: "朝", b: [2, 1] })).not.toBe(await computeEtag(value));
  });

  it("matches If-None-Match lists, * and W/ prefixes", async () => {
    const etag = await computeEtag({ a: 1 });
    const other = await computeEtag({ a: 2 });
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches(` ${other} , W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches(`${other},${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches(" * ", etag)).toBe(true);
  });

  it("does not match absent, stale or malformed headers", async () => {
    const etag = await computeEtag({ a: 1 });
    const bare = etag.slice(1, -1);
    for (const header of [null, undefined, "", other(), bare, `"${bare}`, `${etag} junk`, `*, ${etag}`, `w/${etag}`, `W/ ${etag}`]) {
      expect(ifNoneMatchMatches(header, etag)).toBe(false);
    }
    function other(): string {
      return `"${"0".repeat(64)}"`;
    }
  });
});
