import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { blankLineAround, fillBlankLine, filterBlockChoices, type BlockChoice } from "./block-types";

/**
 * 本文の「/」（と全角の「／」）のブロックの一覧（@tiptap/suggestion を 2 つ。plugin key を分ける）。
 * 表示は React（src/components/PageChrome.tsx）が、エディタごとの store を購読して描く。フォーカスは本文に残したまま
 * （「/」のあとの文字で絞り込めるように）、↑↓・Enter・Esc はここで受ける。
 *
 * - 開くのは空の行（本文の直下の段落・見出しで、「/」と絞り込みの文字の外が空白だけ）だけ（block-types.ts の blankLineAround）。
 * - 日本語入力の変換中は開かない・キーを横取りしない。確定したあとに、その位置で開くかを見直す。
 */

export type SlashMenuSnapshot = {
  items: readonly BlockChoice[];
  index: number;
  query: string;
  rect: DOMRect | null;
};

type Props = SuggestionProps<BlockChoice, BlockChoice>;

export class SlashMenuStore {
  private snapshot: SlashMenuSnapshot | null = null;
  private owner: PluginKey | null = null;
  private props: Props | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: Editor) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SlashMenuSnapshot | null => this.snapshot;

  private set(snapshot: SlashMenuSnapshot | null): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  show(owner: PluginKey, props: Props): void {
    const sameQuery = this.owner === owner && this.props?.query === props.query;
    this.owner = owner;
    this.props = props;
    const index = sameQuery && this.snapshot ? Math.min(this.snapshot.index, Math.max(0, props.items.length - 1)) : 0;
    this.set({ items: props.items, index, query: props.query, rect: props.clientRect?.() ?? null });
  }

  /** 開いた側の plugin が閉じたときだけ閉じる（「/」と「／」が同じ取引で入れ替わっても消えない）。 */
  hide(owner: PluginKey): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.props = null;
    this.set(null);
  }

  select(index: number): void {
    if (!this.snapshot || index === this.snapshot.index || index < 0 || index >= this.snapshot.items.length) return;
    this.set({ ...this.snapshot, index });
  }

  move(delta: number): void {
    if (!this.snapshot) return;
    const count = this.snapshot.items.length;
    if (count === 0) return;
    this.set({ ...this.snapshot, index: (this.snapshot.index + delta + count) % count });
  }

  choose(index?: number): void {
    const item = this.snapshot?.items[index ?? this.snapshot.index];
    if (item && this.props) this.props.command(item);
  }

  /** 一覧を閉じる（「/」の文字は残す。同じ位置で打ち続けても開き直さない）。 */
  close(): void {
    if (!this.owner || this.editor.isDestroyed) return;
    exitSuggestion(this.editor.view, this.owner);
  }

  /** 一覧が出ている間のキー。項目が 0 件・変換中・修飾キー付きは横取りしない（Esc は suggestion が閉じる）。 */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.snapshot || this.snapshot.items.length === 0) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    switch (event.key) {
      case "ArrowDown":
        this.move(1);
        return true;
      case "ArrowUp":
        this.move(-1);
        return true;
      case "Enter":
        if (event.shiftKey) return false;
        this.choose();
        return true;
      default:
        return false;
    }
  }
}

const stores = new WeakMap<Editor, SlashMenuStore>();

export function slashMenuStore(editor: Editor): SlashMenuStore {
  let store = stores.get(editor);
  if (!store) {
    store = new SlashMenuStore(editor);
    stores.set(editor, store);
  }
  return store;
}

export const SLASH_KEYS = { half: new PluginKey("pageSlashMenu"), full: new PluginKey("pageSlashMenuFull") } as const;

/** 変換の確定のあとに出す、中身の無い取引の印。 */
const RECHECK = new PluginKey("pageSlashMenuRecheck");
/** 確定（compositionend）から見直しまでの間。ProseMirror が確定を読み終える（20ms）のを待つ。 */
const RECHECK_AFTER_COMPOSITION_MS = 30;

function suggestion(editor: Editor, char: string, pluginKey: PluginKey): SuggestionOptions<BlockChoice, BlockChoice> {
  const store = slashMenuStore(editor);
  return {
    editor,
    char,
    pluginKey,
    // 行の中身は allow で見る（空白だけの行。全角の空白も）
    allowedPrefixes: null,
    allowSpaces: false,
    allow: ({ editor: current, state, range }) => !current.view.composing && blankLineAround(state.doc, range) !== null,
    items: ({ query }) => filterBlockChoices(query),
    command: ({ editor: current, range, props }) => {
      fillBlankLine(current, props.id, { range });
    },
    render: () => ({
      onStart: (props) => store.show(pluginKey, props),
      onUpdate: (props) => store.show(pluginKey, props),
      onExit: () => store.hide(pluginKey),
      onKeyDown: ({ event }) => store.keyDown(event),
    }),
  };
}

/**
 * suggestion は取引のたびに「/」を探す。変換の確定では取引が来ないことがあり、確定した「／」や「/見」で
 * 一覧が開かないままになる。確定のあとに中身の無い取引を 1 つ出して見直させる。
 */
function recheckAfterComposition(): Plugin {
  return new Plugin({
    key: RECHECK,
    props: {
      handleDOMEvents: {
        compositionend: (view) => {
          window.setTimeout(() => {
            if (view.isDestroyed || view.composing) return;
            view.dispatch(view.state.tr.setMeta(RECHECK, true).setMeta("addToHistory", false));
          }, RECHECK_AFTER_COMPOSITION_MS);
          return false;
        },
      },
    },
  });
}

export const PageSlashMenu = Extension.create({
  name: "pageSlashMenu",
  // Enter・↑↓ を、リストの Enter などより先に受ける
  priority: 1100,

  addProseMirrorPlugins() {
    return [
      Suggestion(suggestion(this.editor, "/", SLASH_KEYS.half)),
      Suggestion(suggestion(this.editor, "／", SLASH_KEYS.full)),
      recheckAfterComposition(),
    ];
  },
});
