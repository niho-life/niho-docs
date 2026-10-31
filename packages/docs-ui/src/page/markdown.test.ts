import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks } from "./markdown";
import type { Block } from "./blocks";

/** 往復して同じ blocks に戻ることを確かめる（Mac の保管庫は Markdown で持つ）。 */
function roundTrip(blocks: Block[]): Block[] {
  const markdown = blocksToMarkdown(blocks);
  expect(markdown.ok, markdown.ok ? "" : markdown.reason).toBe(true);
  if (!markdown.ok) throw new Error(markdown.reason);
  const back = markdownToBlocks(markdown.markdown);
  expect(back.ok, back.ok ? "" : back.reason).toBe(true);
  if (!back.ok) throw new Error(back.reason);
  return back.blocks;
}

const text = (value: string): Block => ({ type: "text", text: value });

describe("限定 AST ↔ Markdown", () => {
  it("空の本文は空の配列", () => {
    expect(markdownToBlocks("")).toEqual({ ok: true, blocks: [] });
    expect(markdownToBlocks("\n  \n")).toEqual({ ok: true, blocks: [] });
    expect(blocksToMarkdown([])).toEqual({ ok: true, markdown: "" });
  });

  it("段落・見出し・箇条書き・番号付き・引用・区切り線が往復する", () => {
    const blocks: Block[] = [
      { type: "heading", attrs: { level: 2 }, content: [text("見出し")] },
      { type: "paragraph", content: [text("本文の段落。")] },
      { type: "heading", attrs: { level: 3 }, content: [text("小見出し")] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("ひとつめ")] }] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("順番")] }] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [text("引用")] }] },
      { type: "horizontalRule" },
      { type: "paragraph", content: [text("おわり")] },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("太字・斜体・リンク・改行が往復する", () => {
    const blocks: Block[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "太字", marks: [{ type: "bold" }] },
          text("と"),
          { type: "text", text: "斜体", marks: [{ type: "italic" }] },
          { type: "hardBreak" },
          { type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
        ],
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("囲みは引用の中の目印で往復する（旧い画面では引用として読める）", () => {
    const blocks: Block[] = [
      { type: "callout", content: [{ type: "paragraph", content: [text("囲みの中")] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [text("ふつうの引用")] }] },
    ];
    const markdown = blocksToMarkdown(blocks);
    expect(markdown.ok).toBe(true);
    if (!markdown.ok) throw new Error(markdown.reason);
    expect(markdown.markdown).toContain("> [!note]");
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("番号付きの起点を保つ", () => {
    const blocks: Block[] = [
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("みっつめから")] }] }],
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("記号を含む本文が、往復で記号のまま残る（斜体・コードに化けない）", () => {
    for (const text of ["a * b * c", "小計 * 2 個", "値は `code` と書く", "a_b_c", "[かっこ] と ~~波~~", "# シャープ", "- ハイフン", "1. 数字"]) {
      const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
      expect(roundTrip(blocks), text).toEqual(blocks);
    }
  });

  it("バックティックを含む本文を保存したあと、同じページをもう一度開ける", () => {
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "`npm ci` を実行する" }] }];
    const markdown = blocksToMarkdown(blocks);
    expect(markdown.ok).toBe(true);
    if (!markdown.ok) throw new Error(markdown.reason);
    // escape していないと markdown-it が code の token を作り、限定 AST の外なので開けなくなる
    const back = markdownToBlocks(markdown.markdown);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.reason);
    expect(back.blocks).toEqual(blocks);
  });

  it("囲みの目印と同じ文字を打っても、囲みにならない", () => {
    const blocks: Block[] = [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "[!note]" }] }] }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("限定 AST の外の記法は、黙って捨てずに断る", () => {
    for (const markdown of [
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "```ts\nconst a = 1;\n```",
      "    const a = 1;",
      "`code`",
      "![alt](niho-docs-asset:photo.jpg)",
      "# 見出し 1",
      "#### 見出し 4",
      "- [ ] やること",
    ]) {
      const result = markdownToBlocks(markdown);
      expect(result.ok, markdown).toBe(false);
    }
  });

  it("HTML は（旧い画面と同じく）文字のまま持つ", () => {
    const result = markdownToBlocks("<div>html</div>");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocksToMarkdown(result.blocks)).toEqual({ ok: true, markdown: "<div>html</div>" });
  });

  it("保存できない scheme のリンクは、リンクにならず文字のまま残る", () => {
    const result = markdownToBlocks("[押す](javascript:alert(1))");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.blocks)).not.toContain("link");
    expect(JSON.stringify(result.blocks)).toContain("押す");
  });

  it("画像は Markdown に置き場が無いので、書き出しで断る", () => {
    const result = blocksToMarkdown([{ type: "image", attrs: { assetId: "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c" } }]);
    expect(result.ok).toBe(false);
  });

  it("保存できない blocks は断る", () => {
    expect(blocksToMarkdown([{ type: "codeBlock", content: [text("a")] }]).ok).toBe(false);
  });
});
