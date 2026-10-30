import { useEffect, useEffectEvent } from "react";

type PlatformSource = { readonly platform?: string; readonly userAgent?: string; readonly userAgentData?: { readonly platform?: string } };

/** Apple の端末か（⌘ を使うか Ctrl を使うか）。 */
export function isMacPlatform(source: PlatformSource | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!source) return false;
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * 検索を開くショートカットか: Mac は ⌘K、それ以外は Ctrl+K（Mac の Ctrl+K は入力欄の「行末まで削除」なので使わない）。
 * IME の変換中・他の処理が既に扱った keydown・Shift / Option 付きは対象にしない。
 */
export function isSearchShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  if (event.altKey || event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  const key = event.key.toLowerCase();
  // ラテン文字の配列では文字で見る。それ以外（ロシア語の配列など）は物理的な K の位置で見る
  return /^[a-z]$/.test(key) ? key === "k" : event.code === "KeyK";
}

/**
 * ⌘K（Mac）/ Ctrl+K で onOpen を呼ぶ。入力欄・本文の中でも効く。preventDefault はこのショートカットのときだけ。
 * 登録は window の keydown 1 つだけ（onOpen が変わっても付け直さない）で、unmount で外す。
 */
export function useSearchShortcut(onOpen: () => void): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!isSearchShortcut(event, isMacPlatform())) return;
    event.preventDefault();
    onOpen();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
