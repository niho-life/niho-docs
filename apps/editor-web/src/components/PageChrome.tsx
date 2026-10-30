"use client";

import "niho-ui/styles/editor-tokens.css";
import "niho-docs-ui/styles/shell.css";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { FloatingMenuPluginProps } from "@tiptap/extension-floating-menu";
import { useEditorState, type Editor } from "@tiptap/react";
import { FloatingMenu } from "@tiptap/react/menus";
import { Icon, ShellBubbleMenu, ShellMenu, useMenuDismiss, type ShellMenuItem } from "niho-docs-ui/shell";
import {
  BLOCK_CHOICES,
  LINE_TYPE_CHOICES,
  addButtonVisible,
  fillBlankLine,
  isEmptyParagraphAt,
  lineTypeOf,
  setLineType,
  type BlockChoice,
  type BlockChoiceId,
  type LineTypeId,
} from "@/editor/block-types";
import { checkLinkInput } from "@/editor/link-href";
import { slashMenuStore, type SlashMenuSnapshot } from "@/editor/slash-menu";

/** docs-ui の ShellBubbleMenu の plugin key（packages/docs-ui/src/shell/bubble.tsx）。 */
const FORMAT_BAR_KEY = "shellFormatBar";
const ADD_BUTTON_KEY = "pageAddButton";
/** 「AI の提案はまだ使えません」を出しておく長さ。 */
export const AI_NOTICE_MS = 4000;
/** 開いているメニューのボタンをもう一度押したら閉じたままにする（外のクリックで閉じた直後のクリック）。 */
const TOGGLE_WINDOW_MS = 400;
/** 浮かぶ部品と画面の端の間。 */
const VIEWPORT_MARGIN = 8;
/** 書式の帯の最大幅（shell.css の `.es-selwrap>.es-selbar` の 900px 未満の値と同じ）。 */
const BAR_MAX_WIDTH = "calc(100vw - 36px)";
/** 「/」の一覧などを上に出すときの、選んだ文字との間（.es-menu--flow の top: 6px に合わせる）。 */
const ABOVE_GAP = 6;

export const AI_NOTICE_TEXT = "AI の提案はまだ使えません";

type Anchor = { left: number; top: number; bottom: number };

type Panel =
  | { kind: "lineType"; anchor: Anchor | null; current: LineTypeId | null }
  | { kind: "link"; anchor: Anchor | null; range: { from: number; to: number }; href: string; linked: boolean }
  | { kind: "add"; anchor: Anchor | null; at: number };

const BLOCK_IDS: ReadonlySet<string> = new Set(BLOCK_CHOICES.map((choice) => choice.id));

function isBlockChoiceId(id: string): id is BlockChoiceId {
  return BLOCK_IDS.has(id);
}

function isLineTypeId(id: string): id is LineTypeId {
  return id !== "hr" && BLOCK_IDS.has(id);
}

function blockMenuItems(choices: readonly BlockChoice[]): ShellMenuItem[] {
  return choices.map((choice) => ({ id: choice.id, label: choice.label, icon: choice.icon, hint: choice.hint || undefined }));
}

/** 行の種類の一覧。いまの種類は文字（「現在」）でも示す（色だけに頼らない）。 */
function lineTypeItems(current: LineTypeId | null): ShellMenuItem[] {
  return LINE_TYPE_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, icon: choice.icon, hint: choice.id === current ? "現在" : undefined }));
}

const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

/** 選んだ文字の位置（画面の座標）。描画の API が無い環境では null。 */
function selectionAnchor(editor: Editor): Anchor | null {
  const { from, to } = editor.state.selection;
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    return { left: start.left, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
  } catch {
    return null;
  }
}

/**
 * 浮かぶ部品を、目印の下（下に入らなければ上）に置く。位置は .es-root（offsetParent）の中の絶対位置で、
 * 画面の左右の端から出さない（320px の幅でも横に溢れない）。
 */
function placeNear(element: HTMLElement, anchor: Anchor): void {
  const parent = element.offsetParent;
  if (!(parent instanceof HTMLElement)) return;
  const base = parent.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewportWidth - VIEWPORT_MARGIN - width));
  const above = anchor.top - height - ABOVE_GAP;
  const top = anchor.bottom + height > viewportHeight - VIEWPORT_MARGIN && above >= VIEWPORT_MARGIN ? above : anchor.bottom;
  element.style.left = `${left - base.left}px`;
  element.style.top = `${top - base.top}px`;
}

/** 位置だけを持つ入れ物（見た目は中の .es-* が持つ）。幅は中身に合わせ、画面より広くしない。 */
const FLOATING_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: "max-content",
  maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
};

function Floating({ anchor, children, ...props }: { anchor: Anchor | null } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current && anchor) placeNear(ref.current, anchor);
  });
  return (
    <div ref={ref} style={FLOATING_STYLE} {...props}>
      {children}
    </div>
  );
}

const noSnapshot = (): SlashMenuSnapshot | null => null;

/**
 * 「/」のブロックの一覧（src/editor/slash-menu.ts の store を描く）。見た目は ShellMenu・ShellBlockMenu と同じ class。
 * フォーカスは本文に残す（「/」のあとの文字で絞り込む・変換を邪魔しない）ので、ShellMenu（開くと先頭にフォーカスを移す）は使わない。
 * いまの項目は太字と面で示し、本文に aria-activedescendant を付けて読み上げにも伝える。
 */
function SlashList({ editor }: { editor: Editor }) {
  const store = slashMenuStore(editor);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, noSnapshot);
  const menuId = useId();
  const items = snapshot?.items ?? [];
  const active = snapshot && items.length > 0 ? items[snapshot.index] : undefined;
  const activeId = active ? `${menuId}-${active.id}` : null;

  useEffect(() => {
    if (!activeId || editor.isDestroyed) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-controls", menuId);
    dom.setAttribute("aria-activedescendant", activeId);
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, menuId, activeId]);

  // 本文からフォーカスが離れたら閉じる（「/」の文字は残す）
  useEffect(() => {
    const onBlur = () => {
      queueMicrotask(() => {
        if (store.getSnapshot()) store.close();
      });
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor, store]);

  if (!snapshot || items.length === 0) return null;
  const rect = snapshot.rect;
  return (
    <Floating anchor={rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null}>
      <div id={menuId} className="es-menu es-menu--flow" role="menu" aria-label="ブロックを足す" data-slash-menu="">
        {items.map((item, index) => (
          <button
            key={item.id}
            id={`${menuId}-${item.id}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={index === snapshot.index ? "es-mi es-mi--on" : "es-mi"}
            onMouseDown={keepFocus}
            onMouseEnter={() => store.select(index)}
            onClick={() => store.choose(index)}
          >
            {item.icon && <Icon name={item.icon} />}
            {item.label}
            {item.hint ? <small>{item.hint}</small> : null}
          </button>
        ))}
      </div>
    </Floating>
  );
}

function LinkForm(props: { href: string; linked: boolean; onApply: (href: string) => void; onRemove: () => void; onCancel: () => void; onOutside: () => void }) {
  const { onApply, onCancel } = props;
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(props.href);
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const problemId = useId();
  useMenuDismiss(formRef, props.onOutside);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = checkLinkInput(value);
    if (!result.ok) {
      setProblem(result.reason);
      inputRef.current?.focus();
      return;
    }
    onApply(result.href);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    // useMenuDismiss（document の Esc）より先に、選択へ戻して閉じる
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <form ref={formRef} className="es-card" aria-label="リンク" noValidate onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="es-field">
        <label htmlFor={inputId}>リンク先の URL</label>
        <input
          ref={inputRef}
          id={inputId}
          className="es-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://"
          value={value}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
        />
      </div>
      {problem && (
        <p id={problemId} role="alert" className="es-danger">
          {problem}
        </p>
      )}
      <div className="es-acts">
        <button type="submit" className="es-btn es-btn--sm es-btn--primary">
          設定
        </button>
        {props.linked && (
          <button type="button" className="es-btn es-btn--sm es-btn--outline" onClick={props.onRemove}>
            リンクを外す
          </button>
        )}
        <button type="button" className="es-btn es-btn--sm es-btn--quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

const shouldShowAddButton: NonNullable<FloatingMenuPluginProps["shouldShow"]> = ({ editor, view, state }) =>
  addButtonVisible(state, editor.isEditable, view.hasFocus());

/**
 * 書式の帯（ShellBubbleMenu）を .es-root（root）の中に付けさせる。ShellBubbleMenu は付ける先（appendTo）を受けないので、
 * TipTap の menus が props の更新に使う meta（"updateOptions"）で渡す（docs-ui に appendTo が足されたら、これは要らない）。
 *
 * 帯の plugin は登録のたびに作り直され、渡した値を忘れる（開発の StrictMode は effect を付け直す。ほかの plugin の登録でも
 * 全ての plugin の view が作り直される）。そこで、帯と＋の後ろに置いて登録より後に渡し、さらに本文にフォーカスが来たとき・
 * 選択が始まったとき（帯は選択の 250ms 後に出る）にも渡し直す。中身の無い取引なので、本文・履歴・保存には影響しない。
 */
function FormatBarRoute({ editor, root }: { editor: Editor; root: HTMLElement }) {
  useEffect(() => {
    const route = () => {
      if (editor.isDestroyed) return;
      const options = {
        appendTo: root,
        options: {
          // 画面の端に貼り付かない
          shift: { padding: VIEWPORT_MARGIN },
          onShow: () => {
            const bar = root.querySelector<HTMLElement>(":scope > .es-selbar--live");
            if (!bar) return;
            // 帯の入れ物ではなく、中のボタンだけをタブで止まる場所にする
            bar.tabIndex = -1;
            // 帯は幅 344px ほどあり、320px の画面では横に溢れる。shell.css が静的な帯（.es-selwrap>.es-selbar）に
            // 900px 未満で当てている折り返しと同じ値を、動く帯（.es-selbar--live）にも当てる（docs-ui に足すまでの間）
            bar.style.flexWrap = "wrap";
            bar.style.maxWidth = BAR_MAX_WIDTH;
          },
        },
      };
      editor.view.dispatch(editor.state.tr.setMeta(FORMAT_BAR_KEY, { type: "updateOptions", options }).setMeta("addToHistory", false));
    };
    route();
    let selecting = !editor.state.selection.empty;
    const later = () => queueMicrotask(route);
    const onSelection = () => {
      const now = !editor.state.selection.empty;
      if (now && !selecting) later();
      selecting = now;
    };
    editor.on("focus", later);
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("focus", later);
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, root]);
  return null;
}

function Chrome({ editor }: { editor: Editor }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [aiNotice, setAiNotice] = useState<{ anchor: Anchor | null } | null>(null);
  const escaped = useRef(false);
  const lastDismiss = useRef<{ kind: Panel["kind"]; at: number } | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const addMenu = useRef<HTMLDivElement | null>(null);

  // 押されている状態（太字・斜体）は ShellBubbleMenu が描いたときの値を出す。選択の移動・コマンドのたびに描き直させる
  useEditorState({ editor, selector: ({ editor: current }) => ({ bold: current.isActive("bold"), italic: current.isActive("italic") }) });

  // 「＋」の入れ物は TipTap が tabIndex=0 にする。ボタンだけをタブで止まる場所にする
  const [addButtonOptions] = useState<FloatingMenuPluginProps["options"]>(() => ({
    placement: "left",
    offset: 8,
    onShow: () => {
      if (addMenu.current) addMenu.current.tabIndex = -1;
    },
  }));

  useEffect(() => {
    if (!aiNotice) return;
    const timer = window.setTimeout(() => setAiNotice(null), AI_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [aiNotice]);

  /** 外のクリックで閉じた直後に、同じメニューを開くボタンが押されたか（＝閉じたいだけ）。 */
  const recentlyDismissed = (kind: Panel["kind"]) => {
    const last = lastDismiss.current;
    lastDismiss.current = null;
    return last !== null && last.kind === kind && Date.now() - last.at < TOGGLE_WINDOW_MS;
  };

  /** メニューの onClose（Esc か外のクリック）。Esc なら本文の元の位置（選択）へフォーカスを戻す。 */
  const dismiss = (kind: Panel["kind"]) => {
    setPanel(null);
    if (escaped.current) {
      escaped.current = false;
      editor.commands.focus();
      return;
    }
    lastDismiss.current = { kind, at: Date.now() };
  };

  const noteEscape = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") escaped.current = true;
  };

  /** タブなどでフォーカスがメニューの外へ出たら閉じる（本文へは戻さない）。 */
  const closeOnFocusLeave = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setPanel(null);
  };

  const openLineType = () => {
    if (recentlyDismissed("lineType")) return;
    escaped.current = false;
    setPanel({ kind: "lineType", anchor: selectionAnchor(editor), current: lineTypeOf(editor.state) });
  };

  const openLink = () => {
    if (recentlyDismissed("link")) return;
    const { from, to } = editor.state.selection;
    const linked = editor.isActive("link");
    const href = linked ? String(editor.getAttributes("link").href ?? "") : "";
    setPanel({ kind: "link", anchor: selectionAnchor(editor), range: { from, to }, href, linked });
  };

  const showAiNotice = () => {
    // AI の提案（#36）はまだ無い。本文は変えずに知らせるだけ
    setAiNotice({ anchor: selectionAnchor(editor) });
  };

  const openAdd = () => {
    if (recentlyDismissed("add")) return;
    const { $anchor } = editor.state.selection;
    if ($anchor.depth !== 1 || !isEmptyParagraphAt(editor.state.doc, $anchor.before())) return;
    const rect = addButton.current?.getBoundingClientRect();
    escaped.current = false;
    setPanel({ kind: "add", at: $anchor.before(), anchor: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : selectionAnchor(editor) });
  };

  const linkRange = panel?.kind === "link" ? panel.range : null;

  return (
    <div ref={setRoot} className="es-root" data-page-chrome="">
      {root && (
        <>
          <ShellBubbleMenu editor={editor} onTextType={openLineType} onLink={openLink} onAi={showAiNotice} />
          <FloatingMenu ref={addMenu} editor={editor} pluginKey={ADD_BUTTON_KEY} appendTo={root} shouldShow={shouldShowAddButton} options={addButtonOptions}>
            <button
              ref={addButton}
              type="button"
              className="es-ib es-ib--sm"
              aria-label="ブロックを追加"
              aria-haspopup="menu"
              aria-expanded={panel?.kind === "add"}
              onMouseDown={keepFocus}
              onClick={openAdd}
            >
              <Icon name="plus" />
            </button>
          </FloatingMenu>
          {/* 帯・＋の plugin の登録より後に動かすため、それらの後ろに置く */}
          <FormatBarRoute editor={editor} root={root} />
        </>
      )}
      <SlashList editor={editor} />
      {panel?.kind === "lineType" && (
        <Floating anchor={panel.anchor} onKeyDownCapture={noteEscape} onBlur={closeOnFocusLeave}>
          <ShellMenu
            label="行の種類"
            className="es-menu--flow"
            items={lineTypeItems(panel.current)}
            onSelect={(id) => {
              setPanel(null);
              if (isLineTypeId(id)) setLineType(editor, id);
            }}
            onClose={() => dismiss("lineType")}
          />
        </Floating>
      )}
      {panel?.kind === "add" && (
        <Floating anchor={panel.anchor} onKeyDownCapture={noteEscape} onBlur={closeOnFocusLeave}>
          <ShellMenu
            label="ブロックを足す"
            className="es-menu--flow"
            items={blockMenuItems(BLOCK_CHOICES)}
            onSelect={(id) => {
              setPanel(null);
              if (isBlockChoiceId(id)) fillBlankLine(editor, id, { at: panel.at });
            }}
            onClose={() => dismiss("add")}
          />
        </Floating>
      )}
      {panel?.kind === "link" && linkRange && (
        <Floating anchor={panel.anchor}>
          <LinkForm
            href={panel.href}
            linked={panel.linked}
            onApply={(href) => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).setLink({ href }).run();
            }}
            onRemove={() => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).extendMarkRange("link").unsetLink().run();
            }}
            onCancel={() => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).run();
            }}
            onOutside={() => dismiss("link")}
          />
        </Floating>
      )}
      <Floating anchor={aiNotice?.anchor ?? null} role="status" aria-live="polite" data-ai-notice="">
        {aiNotice && <p className="es-card">{AI_NOTICE_TEXT}</p>}
      </Floating>
    </div>
  );
}

/**
 * 本文のエディタに付ける操作の部品（モック v6 の shell の部品で描く。見た目は niho-docs-ui/styles/shell.css）。
 * - 選んだ文字の上の書式の帯（ShellBubbleMenu）: 太字・斜体・見出し・箇条書きは帯が editor のコマンドへ、
 *   行の種類（ShellMenu）・リンク（帯の下の小さな入力）・AI（まだ使えないと知らせる）はここが持つ。
 * - 空の行の「/」（src/editor/slash-menu.ts）と、空の段落の左の「＋」のブロックの一覧。
 * 作れるのは限定 AST の範囲だけ（src/editor/block-types.ts）。常設の書式の帯（ShellTools）はヘッダーの側が持つ。
 *
 * shell.css のセレクタは `[data-docs-app-root][data-docs-shared-ui]` の中の `.es-root` の中だけに効く。本文を .es-root に入れると
 * 本文の見た目（リストの印・リンクの下線など）が shell の reset で変わるので、.es-root はこの部品の入れ物だけにし、
 * 浮かぶ部品（帯・＋・一覧・入力）はすべてこの中に付ける。`.be`（position: relative）の中に置く。
 */
export function PageChrome({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return <Chrome editor={editor} />;
}
