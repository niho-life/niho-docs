import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { isSafeLinkHref } from "./blocks";
import { PageCallout } from "./callout";

/**
 * 限定 AST（blocks.ts）のうち、画面の部品を持たない分（段落・見出し 2・3・箇条書き・番号付き・引用・囲み・区切り線と、
 * 行の中の太字・斜体・リンク・改行）。エディタの schema（page-extensions.ts）はこれに画像と「/」の一覧を足したもの。
 *
 * **React に触れない**ので、サーバー（editor-web の AI チャットがページを Markdown で読み書きする道具）からも読める。
 * 画像は NodeView（React）を持つのでここには無い。Markdown に画像の置き場は無く、markdown.ts は画像のある本文を
 * 断るので、往復の schema はこれで足りる（差は editor-schema.test.ts が固定している）。
 */
export function buildMarkdownExtensions(): Extensions {
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
    PageCallout,
  ];
}
