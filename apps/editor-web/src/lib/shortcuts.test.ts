// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isMod, isSaveShortcut, shortcutOf, type ShortcutId } from "./shortcuts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

describe("shortcutOf", () => {
  const cases: [ShortcutId, KeyboardEventInit][] = [
    ["newPage", { key: "n" }],
    ["search", { key: "k" }],
    ["blockMenu", { key: "/" }],
    ["publish", { key: "P", shiftKey: true }],
  ];

  it("reads ⌘ on a Mac and Ctrl elsewhere for each shortcut of the design (§11)", () => {
    for (const [id, init] of cases) {
      expect(shortcutOf(key({ ...init, metaKey: true }), true), id).toBe(id);
      expect(shortcutOf(key({ ...init, ctrlKey: true }), false), id).toBe(id);
      // Mac の Ctrl（入力欄の Emacs 風の操作）と、Mac 以外の ⌘（Windows キー）は使わない
      expect(shortcutOf(key({ ...init, ctrlKey: true }), true), id).toBeNull();
      expect(shortcutOf(key({ ...init, metaKey: true }), false), id).toBeNull();
    }
  });

  it("ignores the keys without the modifier, with ⌥ or both ⌘ and Ctrl, and a missing or extra ⇧", () => {
    expect(shortcutOf(key({ key: "n" }), false)).toBeNull();
    expect(shortcutOf(key({ key: "n", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ key: "n", ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ key: "N", ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ key: "k", metaKey: true, shiftKey: true }), true)).toBeNull();
    // ⌘P（印刷）はブラウザに任せる。公開のシートは ⌘⇧P だけ
    expect(shortcutOf(key({ key: "p", metaKey: true }), true)).toBeNull();
    expect(shortcutOf(key({ key: "s", metaKey: true }), true)).toBeNull();
  });

  it("ignores a keydown while the IME is composing or already handled by something else", () => {
    expect(shortcutOf(key({ key: "n", metaKey: true, isComposing: true }), true)).toBeNull();
    expect(shortcutOf(key({ key: "Process", keyCode: 229, metaKey: true }), true)).toBeNull();
    const handled = key({ key: "/", metaKey: true });
    handled.preventDefault();
    expect(shortcutOf(handled, true)).toBeNull();
  });

  it("uses the physical key on non-Latin layouts but not on other Latin layouts", () => {
    expect(shortcutOf(key({ key: "т", code: "KeyN", ctrlKey: true }), false)).toBe("newPage");
    expect(shortcutOf(key({ key: "З", code: "KeyP", ctrlKey: true, shiftKey: true }), false)).toBe("publish");
    expect(shortcutOf(key({ key: "y", code: "KeyN", ctrlKey: true }), false)).toBeNull();
    // 「/」: ⇧ で「/」を打つ配列も受ける。記号を出さない配列だけ物理的な位置で見る
    expect(shortcutOf(key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }), false)).toBe("blockMenu");
    expect(shortcutOf(key({ key: "ظ", code: "Slash", ctrlKey: true }), false)).toBe("blockMenu");
    expect(shortcutOf(key({ key: "-", code: "Slash", ctrlKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ key: "?", code: "Slash", metaKey: true, shiftKey: true }), true)).toBeNull();
  });
});

describe("isMod", () => {
  it("is ⌘ alone on a Mac and Ctrl alone elsewhere, never with ⌥", () => {
    expect(isMod(key({ key: "x", metaKey: true }), true)).toBe(true);
    expect(isMod(key({ key: "x", ctrlKey: true }), false)).toBe(true);
    expect(isMod(key({ key: "x", metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isMod(key({ key: "x", metaKey: true, altKey: true }), true)).toBe(false);
  });
});

describe("isSaveShortcut", () => {
  it("keeps ⌘S and Ctrl+S on every platform, and leaves ⇧ / ⌥ combinations to the browser", () => {
    expect(isSaveShortcut(key({ key: "s", metaKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: "S", ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: "s", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveShortcut(key({ key: "s", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSaveShortcut(key({ key: "s" }))).toBe(false);
  });

  it("still takes ⌘S while the IME is composing, so the browser's save dialog never opens", () => {
    expect(isSaveShortcut(key({ key: "s", metaKey: true, isComposing: true }))).toBe(true);
  });
});
