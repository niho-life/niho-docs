// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { aiScopeOf, selectionRange } from "./ai-scope";
import { buildPageExtensions } from "./page-extensions";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const p = (value: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const li = (value: string): JSONContent => ({ type: "listItem", content: [p(value)] });

/** 最上位のブロック: 0 段落・1 段落・2 箇条書き（2 項目）・3 区切り線・4 引用・5 段落。 */
const BODY: JSONContent = {
  type: "doc",
  content: [p("一つ目の段落"), p("二つ目の段落"), { type: "bulletList", content: [li("項目A"), li("項目B")] }, { type: "horizontalRule" }, { type: "blockquote", content: [p("引用の中")] }, p("最後の段落")],
};

function open(content: JSONContent = BODY): Editor {
  editor = new Editor({ extensions: buildPageExtensions(), content });
  return editor;
}

/** 本文の中の文字の位置（offset はその文字列の中の何文字目か）。 */
function at(target: Editor, text: string, offset = 0): number {
  let found = -1;
  target.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text) + offset;
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

function scopeOfText(target: Editor, from: number, to: number) {
  return aiScopeOf(target.state.doc, selectionRange(target.state.apply(target.state.tr.setSelection(TextSelection.create(target.state.doc, from, to)))));
}

describe("aiScopeOf: a selection to the range of top-level blocks", () => {
  it("covers every top-level block the selection crosses", () => {
    const target = open();
    expect(scopeOfText(target, at(target, "一つ目", 1), at(target, "二つ目", 2))).toEqual({ fromIndex: 0, toIndex: 1 });
    expect(scopeOfText(target, at(target, "二つ目", 1), at(target, "最後", 1))).toEqual({ fromIndex: 1, toIndex: 5 });
  });

  it("takes the whole list (or quote) for a selection inside one of its items", () => {
    const target = open();
    expect(scopeOfText(target, at(target, "項目B"), at(target, "項目B", 2))).toEqual({ fromIndex: 2, toIndex: 2 });
    expect(scopeOfText(target, at(target, "項目A", 1), at(target, "項目B", 1))).toEqual({ fromIndex: 2, toIndex: 2 });
    expect(scopeOfText(target, at(target, "引用"), at(target, "引用", 2))).toEqual({ fromIndex: 4, toIndex: 4 });
    // 段落からリストの中まで
    expect(scopeOfText(target, at(target, "二つ目"), at(target, "項目A", 2))).toEqual({ fromIndex: 1, toIndex: 2 });
  });

  it("leaves out a block the selection only touches at its edge (a whole line selected up to the next line's start)", () => {
    const target = open();
    // 二つ目の段落を行ごと選ぶと、終わりは次のブロック（リスト）の最初の文字の前になる
    expect(scopeOfText(target, at(target, "二つ目"), at(target, "項目A"))).toEqual({ fromIndex: 1, toIndex: 1 });
    // 始まりが前の段落の末尾
    expect(scopeOfText(target, at(target, "一つ目の段落", 6), at(target, "二つ目", 2))).toEqual({ fromIndex: 1, toIndex: 1 });
  });

  it("counts a horizontal rule as content when the selection spans it", () => {
    const target = open();
    const { state } = target;
    const rule = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + state.doc.child(2).nodeSize;
    expect(aiScopeOf(state.doc, selectionRange(state.apply(state.tr.setSelection(NodeSelection.create(state.doc, rule)))))).toEqual({ fromIndex: 3, toIndex: 3 });
    expect(aiScopeOf(state.doc, { from: rule, to: at(target, "引用", 1) })).toEqual({ fromIndex: 3, toIndex: 4 });
  });

  it("covers the whole page for ⌘A", () => {
    const target = open();
    const { state } = target;
    expect(aiScopeOf(state.doc, selectionRange(state.apply(state.tr.setSelection(new AllSelection(state.doc)))))).toEqual({ fromIndex: 0, toIndex: 5 });
  });

  it("is the whole page (no scope) without a selection, and one block for a range that collapsed", () => {
    const target = open();
    const cursor = target.state.apply(target.state.tr.setSelection(TextSelection.create(target.state.doc, at(target, "二つ目", 1))));
    expect(selectionRange(cursor)).toBeNull();
    expect(aiScopeOf(cursor.doc, null)).toBeUndefined();
    // 選んだ文字を消して範囲が潰れた（箱を開いたあとの編集）
    expect(aiScopeOf(cursor.doc, { from: at(target, "項目B", 1), to: at(target, "項目B", 1) })).toEqual({ fromIndex: 2, toIndex: 2 });
    // 位置が本文の外（短くなった本文）でも最後のブロックに収める
    expect(aiScopeOf(cursor.doc, { from: 10_000, to: 20_000 })).toEqual({ fromIndex: 5, toIndex: 5 });
  });
});
