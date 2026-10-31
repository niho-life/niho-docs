import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState, type ParseSpec } from "prosemirror-markdown";
import { validateBlocks, type Block } from "./blocks";
import { CALLOUT_NODE_NAME } from "./callout";
import { buildPageExtensions } from "./page-extensions";

/**
 * 限定 AST（blocks.ts）↔ Markdown。
 *
 * Mac（apps/docs）は本文の正本を保管庫の `pages/<id>.md` に Markdown で置く（Web の正本は Cloud SQL の blocks）。
 * 同じエディタを Mac に載せるために、ここで往復させる。**変換できないものは黙って捨てず、必ず断る**
 * （設計 §12・移行の対応表 §4「変換できない要素は取り込まずに報告する」）。
 *
 * - 読む: 表・コード・画像・HTML など限定 AST の外の記法があれば `{ ok: false }`。見出し 1・4 以下も断る（本文は 2・3 だけ）。
 * - 書く: 限定 AST の中だけを書き出す。画像（資産の id を持つ）は Markdown に置き場が無いので断る（#45 の相談の項目）。
 * - 囲み（`callout`）は Markdown に対応する記法が無いので、引用の中の `[!note]` の行で表す。旧い画面で開いても
 *   引用として読めるだけで、本文は欠けない。
 */

/**
 * やることのリスト（`- [ ] …`）。CommonMark には無い記法で、旧い画面（editor/markdown.ts）だけが扱う。
 * CommonMark として読むと `[ ] ` が文字になり、保存で `\[ \] ` に化けて旧い画面のチェックが壊れるので、読む前に断る。
 */
const TASK_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]/m;

/** 囲みの目印（引用の最初の段落）。 */
const CALLOUT_MARKER = "[!note]";

/** 限定 AST と同じ範囲だけの schema（エディタと同じもの）。 */
export const pageMarkdownSchema: Schema = getSchema(buildPageExtensions());

const tokens: Record<string, ParseSpec> = {
  paragraph: { block: "paragraph" },
  blockquote: { block: "blockquote" },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (token) => {
      const start = Number(token.attrGet("start") ?? 1);
      return Number.isSafeInteger(start) && start > 1 ? { start } : {};
    },
  },
  list_item: { block: "listItem" },
  heading: { block: "heading", getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  link: { mark: "link", getAttrs: (token) => ({ href: token.attrGet("href") ?? "" }) },
};

// CommonMark ＋表・取り消し線。HTML は文字として扱い、実行しない。表と取り消し線は限定 AST の外だが、
// **読まないと文字として取り込んでしまい、保存で記法が壊れる**ので、読んで（知らない token として）断る。
const markdownIt = MarkdownIt("commonmark", { html: false }).enable(["table", "strikethrough"]);
const parser = new MarkdownParser(pageMarkdownSchema, markdownIt, tokens);

function inlineMark(open: string) {
  return { open, close: open, mixable: true, expelEnclosingWhitespace: true };
}

const serializer = new MarkdownSerializer(
  {
    paragraph(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.write(`${state.repeat("#", Number(node.attrs.level))} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    bulletList(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderList(node, "  ", () => "- ");
    },
    orderedList(state: MarkdownSerializerState, node: ProseMirrorNode) {
      const start = Number(node.attrs.start ?? 1);
      const width = String(start + node.childCount - 1).length;
      state.renderList(node, state.repeat(" ", width + 2), (index) => {
        const label = String(start + index);
        return `${state.repeat(" ", width - label.length)}${label}. `;
      });
    },
    listItem(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderContent(node);
    },
    blockquote(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    [CALLOUT_NODE_NAME](state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.wrapBlock("> ", null, node, () => {
        state.write(CALLOUT_MARKER);
        state.closeBlock(node);
        state.renderContent(node);
      });
    },
    horizontalRule(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.write("---");
      state.closeBlock(node);
    },
    hardBreak(state: MarkdownSerializerState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number) {
      for (let after = index + 1; after < parent.childCount; after++) {
        if (parent.child(after).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.text(node.text ?? "", false);
    },
  },
  {
    bold: inlineMark("**"),
    italic: inlineMark("*"),
    link: {
      open: "[",
      close(state: MarkdownSerializerState, mark) {
        return `](${state.esc(String(mark.attrs.href ?? ""))})`;
      },
    },
  },
);

export type MarkdownToBlocks = { ok: true; blocks: Block[] } | { ok: false; reason: string };
export type BlocksToMarkdown = { ok: true; markdown: string } | { ok: false; reason: string };

function isMarkerParagraph(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const node = block as { type?: unknown; content?: unknown };
  if (node.type !== "paragraph" || !Array.isArray(node.content) || node.content.length !== 1) return false;
  const only = node.content[0] as { type?: unknown; text?: unknown; marks?: unknown } | undefined;
  return only?.type === "text" && only.text === CALLOUT_MARKER && only.marks === undefined;
}

/** 引用の中の `[!note]` の行を囲みに戻す（中身が空になったら空の段落を 1 つ置く）。 */
function restoreCallouts(blocks: unknown[]): unknown[] {
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const node = block as { type?: unknown; content?: unknown };
    const content = Array.isArray(node.content) ? restoreCallouts(node.content) : node.content;
    if (node.type === "blockquote" && Array.isArray(content) && content.length > 0 && isMarkerParagraph(content[0])) {
      const rest = content.slice(1);
      return { ...node, type: CALLOUT_NODE_NAME, content: rest.length > 0 ? rest : [{ type: "paragraph" }] };
    }
    return Array.isArray(content) ? { ...node, content } : block;
  });
}

/**
 * Markdown を限定 AST の blocks にする。限定 AST の外の記法（表・コード・画像・HTML・見出し 1 と 4 以下）があれば断る。
 * 空の本文は空の配列（エディタは空の段落 1 つを置く）。
 */
export function markdownToBlocks(markdown: string): MarkdownToBlocks {
  if (markdown.trim().length === 0) return { ok: true, blocks: [] };
  if (TASK_ITEM.test(markdown)) return { ok: false, reason: "やることのリストは、この本文のエディタでは開けません" };
  let doc: ProseMirrorNode | null;
  try {
    doc = parser.parse(markdown);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Markdown を読めませんでした" };
  }
  if (doc === null) return { ok: false, reason: "Markdown を読めませんでした" };
  const json = doc.toJSON() as { content?: unknown[] };
  // 保存してよい形だけで組み直す（見出しの深さ・リンクの scheme・入れ子の深さはここで断られる）
  return validateBlocks(restoreCallouts(json.content ?? []));
}

/** 限定 AST の blocks を Markdown にする。Markdown に置き場の無いもの（画像・録音）があれば断る。 */
export function blocksToMarkdown(blocks: readonly Block[]): BlocksToMarkdown {
  if (blocks.length === 0) return { ok: true, markdown: "" };
  const checked = validateBlocks(blocks);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  let doc: ProseMirrorNode;
  try {
    doc = pageMarkdownSchema.nodeFromJSON({ type: "doc", content: checked.blocks });
    doc.check();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "本文を読めませんでした" };
  }
  try {
    return { ok: true, markdown: serializer.serialize(doc, { tightLists: true }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "本文を Markdown にできませんでした" };
  }
}
