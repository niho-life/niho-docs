import { describe, expect, it } from "vitest";
import { MAX_BLOCK_DEPTH, MAX_TITLE_CHARS, parseBlocks, parseCreatePage, parsePagePatch } from "./page-input";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("parseCreatePage", () => {
  it("accepts an empty page and the documented fields", () => {
    expect(parseCreatePage({})).toEqual({ ok: true, value: {} });
    expect(parseCreatePage({ kind: "journal", title: "題名", lang: "en", blocks: [paragraph("本文")] })).toEqual({
      ok: true,
      value: { kind: "journal", title: "題名", lang: "en", blocks: [paragraph("本文")] },
    });
  });

  it("rejects bodies that are not objects, unknown keys, and out-of-range values", () => {
    for (const body of [null, [], "x", 1, { owner: "someone-else" }, { id: "x" }, { kind: "html" }, { lang: "fr" }, { title: 1 }, { title: "a\u0000b" }]) {
      expect(parseCreatePage(body)).toEqual({ ok: false });
    }
    expect(parseCreatePage({ title: "あ".repeat(MAX_TITLE_CHARS) }).ok).toBe(true);
    expect(parseCreatePage({ title: "あ".repeat(MAX_TITLE_CHARS + 1) }).ok).toBe(false);
  });
});

describe("parsePagePatch", () => {
  it("needs at least one field", () => {
    expect(parsePagePatch({})).toEqual({ ok: false });
    expect(parsePagePatch({ title: "" })).toEqual({ ok: true, value: { title: "" } });
  });
});

describe("parseBlocks", () => {
  it("accepts an array of typed objects", () => {
    expect(parseBlocks([]).ok).toBe(true);
    expect(parseBlocks([paragraph("a"), { type: "horizontalRule" }]).ok).toBe(true);
  });

  it("rejects non-arrays, untyped items, NUL, too deep or too large bodies", () => {
    expect(parseBlocks({ type: "doc" }).ok).toBe(false);
    expect(parseBlocks(["<p>html</p>"]).ok).toBe(false);
    expect(parseBlocks([{ text: "no type" }]).ok).toBe(false);
    expect(parseBlocks([null]).ok).toBe(false);
    expect(parseBlocks([paragraph("a\u0000b")]).ok).toBe(false);
    let deep: Record<string, unknown> = { type: "paragraph" };
    for (let index = 0; index < MAX_BLOCK_DEPTH + 2; index++) deep = { type: "blockquote", content: [deep] };
    expect(parseBlocks([deep]).ok).toBe(false);
    expect(parseBlocks([paragraph("x".repeat(1024 * 1024))]).ok).toBe(false);
  });
});
