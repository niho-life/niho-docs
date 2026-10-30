import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, slugFromTitle, slugStem, suggestSlug, validateSlug } from "../src/index.js";
import { PAGE_ID } from "./support/world.js";

describe("slugFromTitle", () => {
  it.each([
    ["A Morning Walk!", "a-morning-walk"],
    ["  Tea & Toast -- 2026  ", "tea-toast-2026"],
    ["Ｔｏｋｙｏ　２０２６", "tokyo-2026"],
    ["①② steps", "12-steps"],
    ["鎌倉 Walk 2026", "walk-2026"],
    ["Café au lait", "caf-au-lait"],
  ])("%s → %s (NFKC, lowercase, ASCII letters / digits / hyphens)", (title, slug) => {
    expect(slugFromTitle(title, PAGE_ID)).toBe(slug);
  });

  it.each([["鎌倉の朝"], ["ﾃｽﾄ"], ["！？"], [""]])("uses p- and the first 8 characters of the page id for %j", (title) => {
    expect(slugFromTitle(title, PAGE_ID)).toBe("p-6f0c2a4e");
  });

  it("cuts at 80 characters without a trailing hyphen", () => {
    const slug = slugFromTitle(`${"a".repeat(79)} b c`, PAGE_ID);
    expect(slug).toBe("a".repeat(79));
    expect(slugFromTitle("word ".repeat(40), PAGE_ID).length).toBeLessThanOrEqual(80);
    expect(validateSlug(slugFromTitle("word ".repeat(40), PAGE_ID)).ok).toBe(true);
  });

  it("may return a reserved word; suggestSlug moves it on", () => {
    expect(slugFromTitle("Index", PAGE_ID)).toBe("index");
    expect(suggestSlug("index", [])).toBe("index-2");
  });
});

describe("validateSlug", () => {
  it.each(["a", "a-b", "walk-2026", "p-6f0c2a4e", "x".repeat(160)])("accepts %s", (slug) => {
    expect(validateSlug(slug)).toEqual({ ok: true });
  });

  it.each([
    ["Upper", "format"],
    ["a--b", "format"],
    ["-a", "format"],
    ["a-", "format"],
    ["a_b", "format"],
    ["", "format"],
    ["日本語", "format"],
    [42, "format"],
    ["x".repeat(161), "length"],
  ] as const)("rejects %j (%s)", (slug, reason) => {
    expect(validateSlug(slug)).toEqual({ ok: false, reason });
  });

  it.each(RESERVED_SLUGS)("rejects the reserved word %s", (slug) => {
    expect(validateSlug(slug)).toEqual({ ok: false, reason: "reserved" });
  });
});

describe("suggestSlug", () => {
  it("returns the base when it is free", () => {
    expect(suggestSlug("walk", ["other"])).toBe("walk");
  });

  it("adds -2, -3 … while the slug is taken on the destination", () => {
    expect(suggestSlug("walk", ["walk"])).toBe("walk-2");
    expect(suggestSlug("walk", ["walk", "walk-2"])).toBe("walk-3");
    expect(suggestSlug("walk", new Set(["walk", "walk-2", "walk-3", "walk-5"]))).toBe("walk-4");
  });

  it("skips reserved words", () => {
    expect(suggestSlug("new", [])).toBe("new-2");
    expect(suggestSlug("feed", ["feed-2"])).toBe("feed-3");
  });

  it("numbers a long slug from one stem that leaves room for -9999", () => {
    const base = "x".repeat(160);
    const stem = slugStem(base);
    expect(stem).toBe("x".repeat(155));
    expect(suggestSlug(base, [base])).toBe(`${stem}-2`);
    // Every numbered candidate shares the stem, so a store that reports the slugs under it sees them all.
    expect(suggestSlug(base, [base, `${stem}-2`, `${stem}-3`])).toBe(`${stem}-4`);
    expect(`${stem}-9999`.length).toBeLessThanOrEqual(160);
  });

  it("gives up when nothing up to -9999 is free", () => {
    const taken = ["walk", ...Array.from({ length: 9998 }, (_, index) => `walk-${index + 2}`)];
    expect(suggestSlug("walk", taken)).toBeNull();
  });

  it("keeps a short slug as its own stem", () => {
    expect(slugStem("walk")).toBe("walk");
    expect(slugStem("x".repeat(155))).toBe("x".repeat(155));
  });

  it("returns null for a base that is not slug-shaped", () => {
    expect(suggestSlug("Not A Slug", [])).toBeNull();
  });
});
