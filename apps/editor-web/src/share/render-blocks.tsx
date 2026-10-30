import { Fragment, type ReactNode } from "react";

/**
 * 共有ページ（`/s/{token}`）の本文を React の要素にする（#34）。HTML の文字列は作らず、注入もしない。
 * 本文は TipTap の doc の content（ブロックの配列）。描くのは:
 * paragraph・heading（2 は h2、それ以外は h3）・bulletList・orderedList・listItem・blockquote・horizontalRule・hardBreak・text。
 * mark は bold・italic・link だけ（他の mark は無視して文字だけ）。リンクは https・http・mailto の絶対 URL だけを
 * リンクにし（javascript:・data:・相対・資格情報つきは文字だけ）、常に rel="noopener noreferrer nofollow ugc" を付ける。
 * 未知のノードは投げずに子だけを描く。画像・録音は描かない（資産は未実装）。再帰は深さ 64 で止める。
 */

const MAX_DEPTH = 64;
const LINK_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);
export const SHARED_LINK_REL = "noopener noreferrer nofollow ugc";

type JsonNode = { readonly [key: string]: unknown };

/** 描かないノード（資産）。 */
const SKIPPED = new Set(["image", "docAssetImage", "recording"]);

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** リンクにしてよい先（https・http・mailto の絶対 URL。資格情報・制御文字・空白を含むものは断る）。 */
export function safeShareHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
  return url.href;
}

function renderChildren(node: JsonNode, depth: number): ReactNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.map((child, index) => renderNode(child, index, depth + 1));
}

function renderText(node: JsonNode, key: number): ReactNode {
  if (typeof node.text !== "string" || node.text === "") return null;
  let element: ReactNode = node.text;
  let href: string | null = null;
  let bold = false;
  let italic = false;
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (!isNode(mark)) continue;
      if (mark.type === "bold") bold = true;
      else if (mark.type === "italic") italic = true;
      else if (mark.type === "link" && isNode(mark.attrs)) href = safeShareHref(mark.attrs.href);
    }
  }
  if (italic) element = <em>{element}</em>;
  if (bold) element = <strong>{element}</strong>;
  if (href) {
    element = (
      <a href={href} rel={SHARED_LINK_REL}>
        {element}
      </a>
    );
  }
  return <Fragment key={key}>{element}</Fragment>;
}

function renderNode(value: unknown, key: number, depth: number): ReactNode {
  if (depth > MAX_DEPTH || !isNode(value)) return null;
  switch (value.type) {
    case "text":
      return renderText(value, key);
    case "hardBreak":
      return <br key={key} />;
    case "horizontalRule":
      return <hr key={key} />;
    case "paragraph":
      return <p key={key}>{renderChildren(value, depth)}</p>;
    case "heading":
      return isNode(value.attrs) && value.attrs.level === 2 ? (
        <h2 key={key}>{renderChildren(value, depth)}</h2>
      ) : (
        <h3 key={key}>{renderChildren(value, depth)}</h3>
      );
    case "bulletList":
      return <ul key={key}>{renderChildren(value, depth)}</ul>;
    case "orderedList": {
      const start = isNode(value.attrs) && Number.isInteger(value.attrs.start) && (value.attrs.start as number) > 1 ? (value.attrs.start as number) : undefined;
      return (
        <ol key={key} start={start}>
          {renderChildren(value, depth)}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{renderChildren(value, depth)}</li>;
    case "blockquote":
      return <blockquote key={key}>{renderChildren(value, depth)}</blockquote>;
    default:
      if (SKIPPED.has(String(value.type))) return null;
      // 未知のノードは子だけを描く
      return <Fragment key={key}>{renderChildren(value, depth)}</Fragment>;
  }
}

/** 本文のブロックの配列を描く。 */
export function SharedBlocks(props: { blocks: readonly unknown[] }): ReactNode {
  const blocks = Array.isArray(props.blocks) ? props.blocks : [];
  return <>{blocks.map((block, index) => renderNode(block, index, 1))}</>;
}
