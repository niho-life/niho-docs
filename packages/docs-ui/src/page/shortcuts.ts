/**
 * キーボードのショートカット（設計 §11）。判定はここだけに置く。
 * - ⌘N 新しいページ・⌘K 検索・⌘/ ブロックの一覧・⌘⇧P 公開のシート: Mac は ⌘、それ以外は Ctrl
 *   （Mac の Ctrl+K・Ctrl+N は入力欄の「行末まで削除」「次の行」なので使わない）。IME の変換中・他の処理が既に扱った keydown・
 *   想定外の修飾キー付きは対象にしない。
 * - ⌘S 保存だけは別の判定（isSaveShortcut）。
 * Mac（apps/docs）と Web（apps/editor-web）で同じこの判定を使う（#45）。React の hook は各アプリの側に置く。
 */
export type ShortcutId = "newPage" | "search" | "blockMenu" | "publish";

type PlatformSource = { readonly platform?: string; readonly userAgent?: string; readonly userAgentData?: { readonly platform?: string } };

/** Apple の端末か（⌘ を使うか Ctrl を使うか）。 */
export function isMacPlatform(source: PlatformSource | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!source) return false;
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** ショートカットの修飾キーか: Mac は ⌘（Ctrl なし）、それ以外は Ctrl（⌘ なし）。⌥ 付きは対象にしない。⇧ は各キーが見る。 */
export function isMod(event: KeyboardEvent, mac: boolean): boolean {
  if (event.altKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** ラテン文字の配列では文字で見る。それ以外（ロシア語の配列など）は物理的なキーの位置で見る。 */
const letter = (char: string) => (event: KeyboardEvent) => {
  const key = event.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key === char : event.code === `Key${char.toUpperCase()}`;
};

/** 「/」。⇧ で「/」を打つ配列（ドイツ語など）もあるので ⇧ は問わない。物理的な位置で見るのは、記号を出さない配列で ⇧ なしのときだけ。 */
const slash = (event: KeyboardEvent) => event.key === "/" || (!event.shiftKey && event.code === "Slash" && !/^[\x21-\x7e]$/.test(event.key));

const SHORTCUTS: readonly { id: ShortcutId; shift?: boolean; matches: (event: KeyboardEvent) => boolean }[] = [
  { id: "newPage", shift: false, matches: letter("n") },
  { id: "search", shift: false, matches: letter("k") },
  { id: "blockMenu", matches: slash },
  { id: "publish", shift: true, matches: letter("p") },
];

/** keydown がどのショートカットか（どれでもなければ null）。 */
export function shortcutOf(event: KeyboardEvent, mac: boolean): ShortcutId | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (typeof event.key !== "string" || !isMod(event, mac)) return null;
  return SHORTCUTS.find((shortcut) => (shortcut.shift === undefined || shortcut.shift === event.shiftKey) && shortcut.matches(event))?.id ?? null;
}

/** 検索を開くショートカットか: Mac は ⌘K、それ以外は Ctrl+K。 */
export function isSearchShortcut(event: KeyboardEvent, mac: boolean): boolean {
  return shortcutOf(event, mac) === "search";
}

/**
 * ⌘S・Ctrl+S（どの端末でも両方。⇧・⌥ との組み合わせはブラウザに任せる）。ブラウザの「ページを保存」を出さないため、
 * 変換中・既に扱われた keydown でも取る（変換中の文字は、保存の側が確定を待つ）。
 */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && typeof event.key === "string" && event.key.toLowerCase() === "s";
}
