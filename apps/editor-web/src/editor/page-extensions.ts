import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { isSafeLinkHref } from "@/ast/blocks";
import type { PageImages } from "@/lib/image-upload-client";
import { PageImage } from "./image-node";
import { PageSlashMenu } from "./slash-menu";

/**
 * ページの本文のエディタの schema。限定 AST（src/ast/blocks.ts）と同じ範囲だけを作れる。
 *
 * 段落・見出し 2・3・箇条書き・番号付き・引用・区切り線・画像、行の中は太字・斜体・リンク・改行。
 * 見出し 1（題名の役）・コード・取り消し線・下線・チェックのリストは持たない。
 * 囲み・録音は AST では許すが、作る手段がまだ無いので、この schema には入れていない
 * （`editor-schema.test.ts` が差を固定している。足すときは両方を揃える）。
 *
 * 画像（#33。src/editor/image-node.ts）は実体を private bucket に置くので、アップロードの口（`images`）と、
 * 入れる先のページ（`pageId`。新しいページは最初の保存まで null）を渡したときだけ入れられる。渡さなくても schema は同じ
 * （保存されている画像は読めて描ける）。
 *
 * 空の行の「/」（全角の「／」も）でブロックの一覧を開く（src/editor/slash-menu.ts。ノード・mark は足さない。
 * 一覧で作れるのも、この schema の範囲だけ: src/editor/block-types.ts）。
 */
export type PageExtensionsOptions = {
  /** 画像のアップロードと欄の保存の口（src/lib/image-upload-client.ts）。 */
  images?: PageImages | null;
  /** 今のページの id を返す（まだ作っていなければ null）。 */
  pageId?: () => string | null;
};

export function buildPageExtensions(options: PageExtensionsOptions = {}): Extensions {
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
    PageSlashMenu,
    PageImage.configure({ images: options.images ?? null, pageId: options.pageId ?? null }),
  ];
}
