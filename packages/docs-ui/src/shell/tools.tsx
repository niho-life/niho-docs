import { Icon } from "./icons";

/** 道具の帯の操作。呼ぶ側が TipTap（または別の保存先）につなぐ。 */
export type ShellToolAction = "add-block" | "text-type" | "bold" | "italic" | "link" | "heading" | "list" | "image" | "record";

export type ShellToolsProps = {
  onAction?: (action: ShellToolAction) => void;
  /** ＋（ブロックを足す）でブロックの一覧が開いているか。 */
  blockMenuOpen?: boolean;
};

/**
 * 道具: ＋ ／ テキスト B I リンク ／ 見出し 箇条書き 画像 録音。ヘッダーの中に並べる（狭い幅では ShellMobileToolbar が下端へ出す）。
 * 書式は選んだ文字の上にも出る（ShellBubbleMenu / ShellSelectionBar）。
 */
export function ShellTools({ onAction, blockMenuOpen }: ShellToolsProps) {
  const fire = (action: ShellToolAction) => () => onAction?.(action);
  return (
    <div className="es-tools" data-hscroll role="toolbar" aria-label="書式とブロック">
      <button type="button" className="es-tb" aria-label="ブロックを足す" title="ブロックを足す" aria-haspopup="menu" aria-expanded={blockMenuOpen ?? false} onClick={fire("add-block")}>
        <Icon name="plus" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" className="es-tb" aria-label="行の種類" aria-haspopup="menu" onClick={fire("text-type")}>
        テキスト <span aria-hidden="true">▾</span>
      </button>
      <button type="button" className="es-tb" aria-label="太字" onClick={fire("bold")}>
        <b>B</b>
      </button>
      <button type="button" className="es-tb" aria-label="斜体" onClick={fire("italic")}>
        <i>I</i>
      </button>
      <button type="button" className="es-tb" aria-label="リンク" onClick={fire("link")}>
        <Icon name="link" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" className="es-tb" aria-label="見出し" onClick={fire("heading")}>
        <Icon name="h" />
      </button>
      <button type="button" className="es-tb" aria-label="箇条書き" onClick={fire("list")}>
        <Icon name="list" />
      </button>
      <button type="button" className="es-tb" aria-label="画像" onClick={fire("image")}>
        <Icon name="img" />
      </button>
      <button type="button" className="es-tb" aria-label="録音" onClick={fire("record")}>
        <Icon name="mic" />
      </button>
    </div>
  );
}

/** 900px 未満で、道具を画面の下端に出す帯（右のレールを開いているあいだは隠れる）。 */
export function ShellMobileToolbar(props: ShellToolsProps) {
  return (
    <div className="es-mtb">
      <ShellTools {...props} />
    </div>
  );
}
