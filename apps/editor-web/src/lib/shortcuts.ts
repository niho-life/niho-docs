/**
 * キーボードのショートカット（設計 §11）。判定は共通（packages/docs-ui の page/shortcuts.ts）。
 * この app の hook（React 19 の useEffectEvent を使う）だけがここにある。
 */
import { useEffect, useEffectEvent } from "react";
import { isMacPlatform, shortcutOf, type ShortcutId } from "niho-docs-ui/page/shortcuts";

export { isMacPlatform, isMod, isSaveShortcut, isSearchShortcut, shortcutOf, type ShortcutId } from "niho-docs-ui/page/shortcuts";

export type ShortcutHandlers = Partial<Record<ShortcutId, () => boolean | void>>;

/**
 * handlers のショートカットで呼ぶ。入力欄・本文の中でも効く。handler が false を返したら（いまは使えない）preventDefault せず
 * ブラウザに任せ、それ以外は preventDefault する。登録は window の keydown 1 つだけ（handlers が変わっても付け直さない）で、
 * unmount で外す。
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const id = shortcutOf(event, isMacPlatform());
    const handler = id ? handlers[id] : undefined;
    if (!handler || handler() === false) return;
    event.preventDefault();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
