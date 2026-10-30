/**
 * Markdown is a projection of the AST into the subset niho-experience's
 * guide-markdown accepts: `##` / `###`, paragraphs, flat `-` / `1.` lists, a
 * standalone `![alt](src "caption")` line, `:::note` … `:::`, inline `**`, `*`,
 * `[text](href)`, `[CONFIRM: …]` and backslash escapes. Never HTML, `_`,
 * backticks, `~~`, quotes or thematic breaks. The AST stays the source of truth.
 */

import type { Block, Inline, PublishedAsset } from "./v1.js";
import { isHttpsUrl, isSafeLinkHref } from "./url.js";

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const IS_ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

/** Backslash-escapes every ASCII punctuation character, so text never forms syntax. */
export function escapeMarkdownText(text: string): string {
  return text.replace(ASCII_PUNCTUATION, (char) => `\\${char}`);
}

/** Validated hrefs contain no whitespace or angle brackets; parentheses are percent-encoded. */
function destination(url: string): string {
  return url.replaceAll("(", "%28").replaceAll(")", "%29");
}

interface TextRun {
  readonly kind: "text";
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly href: string | null;
}

interface ConfirmRun {
  readonly kind: "confirm";
  readonly text: string;
}

type Run = TextRun | ConfirmRun;
type Emphasis = "bold" | "italic";

const MARKERS: { readonly [K in Emphasis]: string } = { bold: "**", italic: "*" };

/** Strike and code marks project to plain text; emphasis never starts or ends on whitespace. */
function toRuns(inlines: readonly Inline[]): readonly Run[] {
  const split: Run[] = [];
  for (const inline of inlines) {
    if (inline.type === "confirm") {
      split.push({ kind: "confirm", text: inline.text });
      continue;
    }
    const marks = inline.marks ?? [];
    const bold = marks.some((mark) => mark.type === "bold");
    const italic = marks.some((mark) => mark.type === "italic");
    let href: string | null = null;
    for (const mark of marks) if (mark.type === "link") href = mark.href;
    if (!bold && !italic) {
      split.push({ kind: "text", text: inline.text, bold, italic, href });
      continue;
    }
    const [, lead = "", core = "", trail = ""] = /^(\p{Zs}*)(.*?)(\p{Zs}*)$/su.exec(inline.text) ?? [];
    if (lead) split.push({ kind: "text", text: lead, bold: false, italic: false, href });
    if (core) split.push({ kind: "text", text: core, bold, italic, href });
    if (trail) split.push({ kind: "text", text: trail, bold: false, italic: false, href });
  }
  const merged: Run[] = [];
  for (const run of split) {
    const last = merged.at(-1);
    if (
      last?.kind === "text" && run.kind === "text"
      && last.bold === run.bold && last.italic === run.italic && last.href === run.href
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

function extent(runs: readonly TextRun[], from: number, mark: Emphasis): number {
  let length = 0;
  while (runs[from + length]?.[mark]) length += 1;
  return length;
}

/** Longer-lasting emphasis opens first (outermost), so closers rarely need reopening. */
function renderEmphasis(runs: readonly TextRun[]): string {
  let out = "";
  const stack: Emphasis[] = [];
  runs.forEach((run, position) => {
    const wanted: Emphasis[] = [];
    if (run.bold) wanted.push("bold");
    if (run.italic) wanted.push("italic");
    while (stack.some((mark) => !wanted.includes(mark))) {
      const closed = stack.pop();
      if (closed) out += MARKERS[closed];
    }
    const opening = wanted
      .filter((mark) => !stack.includes(mark))
      .sort((a, b) => extent(runs, position, b) - extent(runs, position, a));
    for (const mark of opening) {
      stack.push(mark);
      out += MARKERS[mark];
    }
    out += escapeMarkdownText(run.text);
  });
  for (let index = stack.length - 1; index >= 0; index -= 1) out += MARKERS[stack[index] as Emphasis];
  return out;
}

function renderInlines(inlines: readonly Inline[]): string {
  const runs = toRuns(inlines);
  let out = "";
  let index = 0;
  while (index < runs.length) {
    const run = runs[index] as Run;
    if (run.kind === "confirm") {
      out += `[CONFIRM: ${escapeMarkdownText(run.text)}]`;
      index += 1;
      continue;
    }
    const group: TextRun[] = [];
    for (let next = runs[index]; next?.kind === "text" && next.href === run.href; next = runs[index]) {
      group.push(next);
      index += 1;
    }
    const inner = renderEmphasis(group);
    out += run.href === null ? inner : `[${inner}](${destination(run.href)})`;
  }
  // Leading spaces could become indentation; trailing spaces a hard break.
  return out.replace(/^ +| +$/g, "");
}

function renderBlock(block: Block, assets: ReadonlyMap<string, PublishedAsset>): string | null {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return renderInlines(block.content);
    case "heading":
      return `${"#".repeat(block.level)} ${renderInlines(block.content)}`;
    case "list":
      return block.items
        .map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${renderInlines(item)}`)
        .join("\n");
    case "figure": {
      const asset = assets.get(block.assetId);
      if (!asset) throw new Error("renderMarkdown: figure refers to a missing asset");
      const title = block.caption === null ? "" : ` "${escapeMarkdownText(block.caption)}"`;
      return `![${escapeMarkdownText(asset.alt)}](${destination(asset.url)}${title})`;
    }
    case "divider":
      return null;
    case "note": {
      const children = block.blocks.map((child) => renderBlock(child, assets)).filter((part) => part);
      return [":::note", children.join("\n\n"), ":::"].join("\n");
    }
  }
}

/** Deterministic projection of validated blocks. Same input, same bytes. */
export function renderMarkdown(blocks: readonly Block[], assets: readonly PublishedAsset[]): string {
  const index = new Map(assets.map((asset) => [asset.id, asset] as const));
  const parts: string[] = [];
  for (const block of blocks) {
    const rendered = renderBlock(block, index);
    if (rendered) parts.push(rendered);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

// --- subset checker ------------------------------------------------------------

export const MARKDOWN_VIOLATION_REASONS = [
  "control-character",
  "indent",
  "nested-list",
  "trailing-whitespace",
  "html",
  "entity",
  "underscore",
  "code",
  "strike",
  "table",
  "quote",
  "thematic-break",
  "setext-heading",
  "heading-level",
  "list-marker",
  "empty",
  "link-definition",
  "link-title",
  "bracket",
  "unsafe-link",
  "bare-url",
  "inline-image",
  "unsafe-image",
  "hard-break",
  "unknown-container",
  "unclosed-note",
  "note-content",
] as const;
export type MarkdownViolationReason = (typeof MARKDOWN_VIOLATION_REASONS)[number];

export interface MarkdownViolation {
  readonly line: number;
  readonly reason: MarkdownViolationReason;
}

const MAX_VIOLATIONS = 100;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;
const ENTITY = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/y;
// A bare https URL is harmless; these schemes must never appear outside a checked destination.
const BARE_SCHEME = /(?:http|mailto|javascript|vbscript|data|file):/iy;
const CONFIRM_OPEN = "[CONFIRM: ";

type InlineContext = "text" | "link-text" | "confirm" | "alt" | "title";
type Report = (reason: MarkdownViolationReason) => void;

function findUnescaped(text: string, char: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === char) return index;
  }
  return -1;
}

function checkInline(text: string, report: Report, context: InlineContext): void {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        report("hard-break");
        return;
      }
      index += IS_ASCII_PUNCTUATION.test(next) ? 2 : 1;
      continue;
    }
    if (char === "<") report("html");
    else if (char === "_") report("underscore");
    else if (char === "`") report("code");
    else if (char === "~") report("strike");
    else if (char === "|") report("table");
    else if (char === "&") {
      ENTITY.lastIndex = index;
      if (ENTITY.test(text)) report("entity");
    } else if (char === "!" && text[index + 1] === "[") {
      report("inline-image");
    } else if (char === "[") {
      if (context === "text" && text.startsWith(CONFIRM_OPEN, index)) {
        const close = findUnescaped(text, "]", index + CONFIRM_OPEN.length);
        if (close === -1) {
          report("bracket");
          return;
        }
        checkInline(text.slice(index + CONFIRM_OPEN.length, close), report, "confirm");
        index = close + 1;
        continue;
      }
      const close = context === "text" ? findUnescaped(text, "]", index + 1) : -1;
      const end = close === -1 || text[close + 1] !== "(" ? -1 : text.indexOf(")", close + 2);
      if (end === -1) {
        report("bracket");
        index += 1;
        continue;
      }
      checkInline(text.slice(index + 1, close), report, "link-text");
      const href = text.slice(close + 2, end);
      if (/\s/u.test(href)) report("link-title");
      else if (!isSafeLinkHref(href)) report("unsafe-link");
      index = end + 1;
      continue;
    } else if (char === "]") {
      report("bracket");
    } else if (index === 0 || !/[A-Za-z0-9+.-]/.test(text[index - 1] ?? "")) {
      BARE_SCHEME.lastIndex = index;
      if (BARE_SCHEME.test(text)) report("bare-url");
    }
    index += 1;
  }
}

function checkImageLine(line: string, report: Report): void {
  const altEnd = findUnescaped(line, "]", 2);
  const tail = altEnd === -1 || line[altEnd + 1] !== "(" ? null : line.slice(altEnd + 2);
  const match = tail === null ? null : /^([^\s)]+)(?: "((?:[^"\\]|\\.)*)")?\)$/u.exec(tail);
  if (!match) {
    report("inline-image");
    return;
  }
  checkInline(line.slice(2, altEnd), report, "alt");
  if (!isHttpsUrl(match[1])) report("unsafe-image");
  if (match[2] !== undefined) checkInline(match[2], report, "title");
}

/** Every construct outside the subset, by 1-based line. Empty means the text is in the subset. */
export function checkMarkdownSubset(markdown: string): readonly MarkdownViolation[] {
  const violations: MarkdownViolation[] = [];
  let noteStart = 0;
  markdown.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const report: Report = (reason) => {
      if (violations.length < MAX_VIOLATIONS) violations.push({ line: lineNumber, reason });
    };
    if (CONTROL.test(line)) return report("control-character");
    if (line === "") return undefined;
    if (line.startsWith(" ")) return report(/^ +(?:[-*+]|\d{1,9}[.)])(?: |$)/.test(line) ? "nested-list" : "indent");
    if (line.endsWith(" ")) report("trailing-whitespace");
    if (line === ":::note") {
      if (noteStart) return report("note-content");
      noteStart = lineNumber;
      return undefined;
    }
    if (line === ":::") {
      if (noteStart) noteStart = 0;
      else report("unknown-container");
      return undefined;
    }
    if (line.startsWith(":::")) return report("unknown-container");
    if (line.startsWith(">")) return report("quote");
    if (/^(?:`{3,}|~{3,})/.test(line)) return report("code");
    if (/^([-*_])(?: *\1){2,} *$/.test(line)) return report("thematic-break");
    if (/^(?:=+|-+) *$/.test(line)) return report("setext-heading");
    if (/^\[[^\]]*\]:/.test(line)) return report("link-definition");
    const heading = /^(#{1,6})(?: (.*))?$/.exec(line);
    if (heading) {
      const level = heading[1]?.length;
      if (level !== 2 && level !== 3) report("heading-level");
      if (noteStart) report("note-content");
      const text = heading[2] ?? "";
      return text.trim() === "" ? report("empty") : checkInline(text, report, "text");
    }
    if (/^(?:[*+]|\d{1,9}\))(?: |$)/.test(line)) return report("list-marker");
    const item = /^(?:-|\d{1,9}\.)(?: (.*))?$/.exec(line);
    if (item) {
      const text = item[1] ?? "";
      return text.trim() === "" ? report("empty") : checkInline(text, report, "text");
    }
    if (line.startsWith("![")) {
      if (noteStart) report("note-content");
      return checkImageLine(line, report);
    }
    return checkInline(line, report, "text");
  });
  if (noteStart && violations.length < MAX_VIOLATIONS) violations.push({ line: noteStart, reason: "unclosed-note" });
  return violations;
}
