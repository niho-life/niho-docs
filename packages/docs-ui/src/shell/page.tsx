import { Fragment, useRef, type ReactNode, type RefObject } from "react";
import { ShellSelectionBar } from "./bubble";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import type { ShellIconName, ShellLang, ShellMenuItem, ShellPageKind } from "./types";

/* ───────────── 本文（静的な見た目。実際の編集は TipTap の EditorContent を children に渡す） ───────────── */

export type ShellInline = string | { kind: "strong"; text: string } | { kind: "confirm"; text: string } | { kind: "sel"; text: string };
export type ShellBodyBlock =
  | { type: "p"; text: ShellInline[] | string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] };

function Inline({ part, onSelectionAi }: { part: ShellInline; onSelectionAi?: () => void }) {
  if (typeof part === "string") return <>{part}</>;
  if (part.kind === "strong") return <strong>{part.text}</strong>;
  // CONFIRM は公開の前に確かめる印（クリックで直しに行く）
  if (part.kind === "confirm") return <mark>{part.text}</mark>;
  return (
    <span className="es-selwrap">
      <span className="es-sel">{part.text}</span>
      <ShellSelectionBar actions={{ onAi: onSelectionAi }} />
    </span>
  );
}

/** 本文の段落・見出し・箇条書きを描く。選んだ文字（sel）には書式の帯が文字の上に付く。 */
export function ShellBody({ blocks, onSelectionAi }: { blocks: ShellBodyBlock[]; onSelectionAi?: () => void }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "h2") return <h2 key={index}>{block.text}</h2>;
        if (block.type === "ul") {
          return (
            <ul key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        const parts = typeof block.text === "string" ? [block.text] : block.text;
        return (
          <p key={index}>
            {parts.map((part, at) => (
              <Fragment key={at}>
                <Inline part={part} onSelectionAi={onSelectionAi} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

/* ───────────── 本文の末尾の「＋」とブロックの一覧 ───────────── */

const BLOCK_ITEMS: ShellMenuItem[] = [
  { id: "text", label: "テキスト", icon: "type" },
  { id: "heading", label: "見出し", icon: "h" },
  { id: "list", label: "箇条書き", icon: "list" },
  { id: "image", label: "画像", icon: "img" },
  { id: "record", label: "録音", icon: "mic", hint: "文字起こし" },
  { id: "audio", label: "音声ファイル", icon: "up", hint: "文字起こし" },
  { id: "divider", label: "区切り線", icon: "minus" },
];

export function ShellBlockMenu({ onPick, onClose, trigger }: { onPick: (id: string) => void; onClose: () => void; trigger?: RefObject<HTMLElement | null> }) {
  return <ShellMenu label="ブロックを足す" className="es-menu--flow" items={BLOCK_ITEMS} trigger={trigger} onSelect={onPick} onClose={onClose} />;
}

export function ShellAddRow({
  hint,
  menuOpen,
  onToggle,
  onPick,
  onClose,
}: {
  /** 空のページで出す「「/」でも出せます」。 */
  hint?: boolean;
  menuOpen: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  if (menuOpen) return <ShellBlockMenu trigger={button} onPick={onPick} onClose={onClose} />;
  return (
    <div className="es-addrow">
      <button ref={button} type="button" aria-label="ブロックを追加" aria-haspopup="menu" aria-expanded={false} onClick={onToggle}>
        <Icon name="plus" />
      </button>
      {hint && <span>「/」でも出せます</span>}
    </div>
  );
}

/* ───────────── ページ ───────────── */

export type ShellMetaItem = { text: string; icon?: ShellIconName } | { author: string; initial: string; text?: string };

export type ShellPageProps = {
  kind: ShellPageKind;
  lang: ShellLang;
  title: string;
  /** 渡すと題名がその場で書ける（フォーカスを外したときに返す）。 */
  onTitleChange?: (title: string) => void;
  /** 記事のカバー。none は「カバー写真」の追加ボタン、set は写真の面（写真は持ち込まず、仮の面で描く）。記事でなければ渡さない。 */
  cover?: "none" | "set";
  onAddCover?: () => void;
  /** 発信先でカテゴリが決まったあとに出る小さな大文字。 */
  kicker?: string;
  meta?: ShellMetaItem[];
  /** 記事のリード。記事でなければ渡さない（空文字は欄だけ出す）。 */
  lead?: string;
  /** ページのいちばん上の帯（手順の ShellSteps band。#37）。無ければ渡さない。 */
  band?: ReactNode;
  /** 録音の文字起こし（ShellRecording）。 */
  media?: ReactNode;
  /** 本文の欄が空のときのプレースホルダー。 */
  bodyPlaceholder?: string;
  /** 本文（ShellBody か TipTap）。 */
  children?: ReactNode;
  /** 本文の下（＋の行）。 */
  footer?: ReactNode;
  /** AI の提案（ShellProposal）。 */
  proposal?: ReactNode;
};

/** ページの中央の列（最大幅 680px）。題名・メタ・リード・文字起こし・本文・提案をこの順に並べる。 */
export function ShellPage(props: ShellPageProps) {
  const ja = props.lang === "ja";
  return (
    <div className="es-canvas-in">
      {props.band}
      {props.cover === "set" && (
        // 画像（role=img）とボタンは兄弟にする。role=img の中にボタンを入れると、ボタンが支援技術から見えなくなる（nested-interactive。#43）
        <div className="es-cover">
          <span className="es-cover-ph" role="img" aria-label="カバー写真（仮の面）" />
          <button type="button" className="es-chg" onClick={props.onAddCover}>
            変更
          </button>
        </div>
      )}
      {props.cover === "none" && (
        <button type="button" className="es-addcover" onClick={props.onAddCover}>
          <Icon name="img" />
          カバー写真
        </button>
      )}
      {props.kicker && <p className="es-kick">{props.kicker.toUpperCase()}</p>}
      <h1
        className={`es-tt${ja ? " es-ja" : ""}`}
        data-ph="無題"
        // 題名が空のときは、見えている「無題」（::before のプレースホルダー）を見出しの名前にする（空の h1 にしない）
        aria-label={props.title ? undefined : "無題"}
        spellCheck={false}
        contentEditable={props.onTitleChange ? true : undefined}
        suppressContentEditableWarning
        onBlur={props.onTitleChange ? (event) => props.onTitleChange?.(event.currentTarget.textContent?.trim() ?? "") : undefined}
      >
        {props.title}
      </h1>
      {props.meta && props.meta.length > 0 && (
        <div className="es-meta">
          {props.meta.map((item, index) =>
            "author" in item ? (
              <Fragment key={index}>
                <span className="es-av es-av--sm" aria-hidden="true">
                  {item.initial}
                </span>
                <span>{item.author}</span>
                {item.text && <span>{item.text}</span>}
              </Fragment>
            ) : (
              <span key={index}>
                {item.icon && <Icon name={item.icon} />}
                {item.text}
              </span>
            ),
          )}
        </div>
      )}
      {props.lead !== undefined && (
        <p className={`es-ld${ja ? " es-ja" : ""}`} data-ph={ja ? "リード" : "Lead"}>
          {props.lead}
        </p>
      )}
      {props.media}
      <div className={`es-bd${ja ? " es-ja" : ""}`} data-ph={props.bodyPlaceholder ?? (ja ? "書く、話す、貼る。「/」でブロック" : "Write, or type “/” for blocks")}>
        {props.children}
      </div>
      {props.footer}
      {props.proposal}
    </div>
  );
}
