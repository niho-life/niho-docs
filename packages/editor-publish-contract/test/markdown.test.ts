import { describe, expect, it } from "vitest";
import { checkMarkdownSubset, escapeMarkdownText, renderMarkdown } from "../src/markdown.js";
import { parseBlocks, parsePublishedDoc } from "../src/validate.js";
import type { Block, Inline, Mark, NoteChild, PublishedAsset } from "../src/v1.js";
import { createRng, type Rng } from "./support/synthetic.js";
import { fixtures, markdownScenarios } from "./support/validator-scenarios.js";

const text = (value: string, ...marks: Mark[]): Inline => (marks.length ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: Inline[]): Block => ({ type: "paragraph", content });
const bold: Mark = { type: "bold" };
const italic: Mark = { type: "italic" };
const link = (href: string): Mark => ({ type: "link", href });

const asset: PublishedAsset = {
  id: "asset-1",
  url: "https://assets.example.com/a/one.jpg",
  contentType: "image/jpeg",
  bytes: 10,
  sha256: "f".repeat(64),
  alt: "Alt *text*",
  credit: null,
};

describe("renderMarkdown golden", () => {
  it("projects the full PublishedDoc fixture", () => {
    expect(renderMarkdown(fixtures.doc.blocks, fixtures.doc.assets)).toBe([
      "Meet at the **station** at 7\\:00 \\(sharp\\)\\. See the [harbor map](/maps/harbor?view=full#start)\\.",
      "",
      "## Route",
      "",
      "1. Walk to the pier",
      "2. Turn left at the *red* gate",
      "3. Follow [**the coastal path**](https://maps.example.com/route_%28coast%29)",
      "",
      "- Water",
      "- Hat \\& sunscreen",
      "",
      "![Fishing boats in the harbor \\[morning\\]](https://assets.example.com/a/harbor_%28morning%29.jpg \"The harbor at 7\\:30 \\\"golden hour\\\"\")",
      "",
      "The sea is calm before nine\\.",
      "",
      "### Tea break",
      "",
      "Try the *matcha* at [**Example Tea**](https://tea.example.com/menu?item=matcha_1)\\. Old menu uses code\\_name\\.",
      "",
      ":::note",
      "Bring cash for the tea house\\.",
      "",
      "- Coins",
      "- **Small bills**",
      ":::",
      "",
      "[CONFIRM: opening hours] may change in winter\\.",
      "",
      "***Bold and italic*** then **bold** ***with italic***",
      "",
    ].join("\n"));
    expect(fixtures.doc.markdown).toBe(renderMarkdown(fixtures.doc.blocks, fixtures.doc.assets));
  });

  it("escapes every ASCII punctuation character in text", () => {
    expect(escapeMarkdownText("<b>_x_ `y` ~~z~~ # > | & [a](b) ! \\")).toBe(
      "\\<b\\>\\_x\\_ \\`y\\` \\~\\~z\\~\\~ \\# \\> \\| \\& \\[a\\]\\(b\\) \\! \\\\",
    );
    expect(renderMarkdown([p(text("1. not a list"))], [])).toBe("1\\. not a list\n");
    expect(renderMarkdown([p(text("- not a list"))], [])).toBe("\\- not a list\n");
    expect(renderMarkdown([p(text(":::note"))], [])).toBe("\\:\\:\\:note\n");
  });

  it("projects quote to a paragraph, drops dividers, and flattens strike and code", () => {
    const blocks: Block[] = [
      { type: "quote", content: [text("Quoted")] },
      { type: "divider" },
      p(text("old", { type: "strike" }), text(" "), text("a_b", { type: "code" })),
    ];
    expect(renderMarkdown(blocks, [])).toBe("Quoted\n\nold a\\_b\n");
  });

  it("keeps emphasis away from whitespace and nests overlapping marks", () => {
    expect(renderMarkdown([p(text("a"), text(" bold ", bold), text("b"))], [])).toBe("a **bold** b\n");
    expect(renderMarkdown([p(text("x", bold, italic), text("y", italic))], [])).toBe("***x**y*\n");
    expect(renderMarkdown([p(text("x", bold), text("y", bold, italic), text("z", bold))], [])).toBe("**x*y*z**\n");
    expect(renderMarkdown([p(text("a", bold), text("b", bold))], [])).toBe("**ab**\n");
    expect(renderMarkdown([p(text("   ", bold))], [])).toBe("");
  });

  it("renders links, figures, notes and confirm markers", () => {
    expect(renderMarkdown([p(text("see "), text("here", link("/a(b)")), text("!"))], [])).toBe("see [here](/a%28b%29)\\!\n");
    expect(renderMarkdown([p({ type: "confirm", text: "date [tbd]" })], [])).toBe("[CONFIRM: date \\[tbd\\]]\n");
    expect(renderMarkdown([{ type: "figure", assetId: "asset-1", caption: null }], [asset])).toBe(
      "![Alt \\*text\\*](https://assets.example.com/a/one.jpg)\n",
    );
    const note: Block = { type: "note", blocks: [{ type: "list", ordered: true, items: [[text("one")], [text("two")]] }] };
    expect(renderMarkdown([note], [])).toBe(":::note\n1. one\n2. two\n:::\n");
    expect(renderMarkdown([], [])).toBe("");
    expect(() => renderMarkdown([{ type: "figure", assetId: "missing", caption: null }], [])).toThrow(/missing asset/);
  });
});

describe("checkMarkdownSubset", () => {
  it("accepts the projection of every positive fixture", () => {
    expect(checkMarkdownSubset(fixtures.doc.markdown)).toEqual([]);
    expect(checkMarkdownSubset("## 見出し\n\n本文、**太字**。\n")).toEqual([]);
  });

  it("reports 1-based lines", () => {
    expect(checkMarkdownSubset("ok\n\n> quote\n\n<b>")).toEqual([
      { line: 3, reason: "quote" },
      { line: 5, reason: "html" },
    ]);
  });

  it("detects every listed violation", () => {
    for (const run of Object.values(markdownScenarios)) expect(run()).toMatchObject({ subset: false });
  });
});

// --- property: any valid AST projects into the subset -----------------------------

const NASTY = ["<script>", "_", "`", "~~", "> ", "# ", "1. ", "- ", "* ", "---", ":::", "[x](javascript:y)", "![i](http://e)", "&amp;", "|", "\\", "**", "*", "http://", "]", "[", "(", ")", "\"", "'", "!"];
const WORDS = ["walk", "海", "tea", "朝", "café", "😀", " ", "  ", " ", "　"];
const HREFS = ["/a", "/a_(b)", "https://example.com/x?y=1&z=2", "https://example.com/*star*", "/q#f"];

function randomText(rng: Rng): string {
  const parts = Array.from({ length: 1 + rng.int(5) }, () => (rng.chance(0.4) ? rng.pick(NASTY) : rng.pick(WORDS)));
  const value = parts.join(rng.chance(0.5) ? " " : "");
  return value.trim() === "" ? `${value}x` : value;
}

function randomInlines(rng: Rng): Inline[] {
  return Array.from({ length: 1 + rng.int(5) }, (): Inline => {
    if (rng.chance(0.1)) return { type: "confirm", text: randomText(rng) };
    const marks: Mark[] = [];
    if (rng.chance(0.3)) marks.push(bold);
    if (rng.chance(0.3)) marks.push(italic);
    if (rng.chance(0.1)) marks.push({ type: "strike" });
    if (rng.chance(0.1)) marks.push({ type: "code" });
    if (rng.chance(0.2)) marks.push(link(rng.pick(HREFS)));
    return text(randomText(rng), ...marks);
  });
}

function randomNoteChild(rng: Rng): NoteChild {
  return rng.chance(0.5)
    ? { type: "paragraph", content: randomInlines(rng) }
    : { type: "list", ordered: rng.chance(0.5), items: Array.from({ length: 1 + rng.int(3) }, () => randomInlines(rng)) };
}

function randomBlock(rng: Rng, assets: readonly PublishedAsset[]): Block {
  switch (rng.int(7)) {
    case 0:
      return { type: "heading", level: rng.chance(0.5) ? 2 : 3, content: randomInlines(rng) };
    case 1:
      return randomNoteChild(rng);
    case 2:
      return { type: "quote", content: randomInlines(rng) };
    case 3:
      return { type: "divider" };
    case 4:
      return { type: "note", blocks: Array.from({ length: 1 + rng.int(3) }, () => randomNoteChild(rng)) };
    case 5:
      return { type: "figure", assetId: rng.pick(assets).id, caption: rng.chance(0.5) ? randomText(rng) : null };
    default:
      return { type: "paragraph", content: randomInlines(rng) };
  }
}

describe("projection property", () => {
  it("renders 400 random valid ASTs into the subset, deterministically", () => {
    const assets: PublishedAsset[] = [
      { ...asset, alt: "a [b] _c_ <d>" },
      { ...asset, id: "asset-2", url: "https://assets.example.com/a/two_(x).png", contentType: "image/png", alt: "" },
    ];
    for (let seed = 1; seed <= 400; seed += 1) {
      const rng = createRng(seed);
      const blocks = Array.from({ length: 1 + rng.int(8) }, () => randomBlock(rng, assets));
      const used = assets.filter((candidate) => blocks.some((block) => block.type === "figure" && block.assetId === candidate.id));
      expect(parseBlocks(blocks, used).ok, `seed ${seed}`).toBe(true);
      const markdown = renderMarkdown(blocks, used);
      expect(checkMarkdownSubset(markdown), `seed ${seed}`).toEqual([]);
      expect(renderMarkdown(structuredClone(blocks), structuredClone(used))).toBe(markdown);
      const doc = { ...fixtures.doc, blocks, assets: used, markdown };
      expect(parsePublishedDoc(doc).ok, `seed ${seed}`).toBe(true);
    }
  });
});
