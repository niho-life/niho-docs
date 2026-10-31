import { Node, mergeAttributes } from "@tiptap/core";

/**
 * 囲み（#33。限定 AST の `callout`。src/ast/blocks.ts）。
 *
 * 引用と同じ「ブロックを包む入れ物」で、属性は持たない（種類・色・見出しの区別を作らない。
 * 限定 AST の `callout` も `content: "blocks"` と `nonEmpty` だけで、属性を 1 つも許していない）。
 * 中に置けるのは、この schema のブロックだけ（`block+`）＝ 保存のときに限定 AST の検査を必ず通る。
 *
 * DOM は `aside[data-callout]`。見た目は共有の docs-ui（`packages/docs-ui/src/styles/editor.css`）に置き、
 * Web と Mac で同じにする。`aside` にしているのは、本文の流れから少し外れた補足だと読み上げにも伝わるため。
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageCallout: {
      /** 選んだ行を囲みで包む。 */
      setCallout: () => ReturnType;
      /** 囲みを外す（中のブロックはそのまま残る）。 */
      unsetCallout: () => ReturnType;
    };
  }
}

export const CALLOUT_NODE_NAME = "callout";

export const PageCallout = Node.create({
  name: CALLOUT_NODE_NAME,
  group: "block",
  // 空の囲みを作らない（限定 AST の nonEmpty と揃える）
  content: "block+",
  // 入れ物の境目を保つ（中で Backspace しても、いきなり外のブロックと混ざらない）
  defining: true,

  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0];
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
