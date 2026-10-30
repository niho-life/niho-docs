import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { isSafeLinkHref } from "@/ast/blocks";

/**
 * ページの本文のエディタの schema。限定 AST（src/ast/blocks.ts）と同じ範囲だけを作れる。
 *
 * 段落・見出し 2・3・箇条書き・番号付き・引用・区切り線、行の中は太字・斜体・リンク・改行。
 * 見出し 1（題名の役）・コード・取り消し線・下線・チェックのリストは持たない。
 * 囲み・画像・録音は AST では許すが、作る手段（画像は資産の保存）がまだ無いので、この schema には入れていない
 * （`editor-schema.test.ts` が差を固定している。足すときは両方を揃える）。
 */
export function buildPageExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      link: {
        openOnClick: false,
        autolink: false,
        // 保存してよい scheme だけをリンクにする（貼り付けた `javascript:` も、設定した値も、文字のままになる）
        isAllowedUri: (url) => isSafeLinkHref(url),
      },
    }),
  ];
}
