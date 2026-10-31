import { useShortcuts } from "./shortcuts";

export { isMacPlatform, isSearchShortcut } from "./shortcuts";

/**
 * ⌘K（Mac）/ Ctrl+K で onOpen を呼ぶ（判定は shortcuts.ts）。入力欄・本文の中でも効く。preventDefault はこのショートカットのときだけ。
 * 登録は window の keydown 1 つだけ（onOpen が変わっても付け直さない）で、unmount で外す。
 */
export function useSearchShortcut(onOpen: () => void): void {
  useShortcuts({ search: onOpen });
}
