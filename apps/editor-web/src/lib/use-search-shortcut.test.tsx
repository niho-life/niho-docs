// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isMacPlatform, isSearchShortcut, useSearchShortcut } from "./use-search-shortcut";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness({ onOpen }: { onOpen: () => void }) {
  useSearchShortcut(onOpen);
  return <input aria-label="本文の代わり" />;
}

async function render(onOpen: () => void) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(<Harness onOpen={onOpen} />));
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function setPlatform(platform: string) {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("isSearchShortcut", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

  it("is ⌘K on a Mac and Ctrl+K elsewhere", () => {
    expect(isSearchShortcut(key({ key: "k", metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(key({ key: "K", metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(isSearchShortcut(key({ key: "k", metaKey: true }), false)).toBe(false);
  });

  it("ignores other keys, extra modifiers, composing input, and events already handled", () => {
    expect(isSearchShortcut(key({ key: "k" }), false)).toBe(false);
    expect(isSearchShortcut(key({ key: "j", ctrlKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true, metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true, isComposing: true }), false)).toBe(false);
    const handled = key({ key: "k", ctrlKey: true });
    handled.preventDefault();
    expect(isSearchShortcut(handled, false)).toBe(false);
  });

  it("uses the physical K key on non-Latin layouts but not on other Latin layouts", () => {
    expect(isSearchShortcut(key({ key: "л", code: "KeyK", ctrlKey: true }), false)).toBe(true);
    expect(isSearchShortcut(key({ key: "t", code: "KeyK", ctrlKey: true }), false)).toBe(false);
  });

  it("detects Apple platforms", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "iPhone" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ platform: "", userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMacPlatform(undefined)).toBe(false);
  });
});

describe("useSearchShortcut", () => {
  it("opens with Ctrl+K off a Mac, also from inside an input, and prevents only that shortcut", async () => {
    setPlatform("Win32");
    const onOpen = vi.fn();
    await render(onOpen);

    const fromWindow = press({ key: "k", ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fromWindow.defaultPrevented).toBe(true);

    const input = container!.querySelector("input")!;
    input.focus();
    const fromInput = press({ key: "k", ctrlKey: true }, input);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(fromInput.defaultPrevented).toBe(true);

    for (const init of [{ key: "k" }, { key: "a", ctrlKey: true }, { key: "k", metaKey: true }]) {
      const other = press(init, input);
      expect(other.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("opens with ⌘K on a Mac and leaves Ctrl+K to the input", async () => {
    setPlatform("MacIntel");
    const onOpen = vi.fn();
    await render(onOpen);
    expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "k", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("ignores the shortcut while an input method is composing", async () => {
    setPlatform("MacIntel");
    const onOpen = vi.fn();
    await render(onOpen);
    const composing = press({ key: "k", metaKey: true, isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
  });

  it("registers one keydown listener on window, calls the latest onOpen, and removes the listener on unmount", async () => {
    setPlatform("Win32");
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const first = vi.fn();
    const second = vi.fn();
    await render(first);
    await render(second);
    const keydowns = add.mock.calls.filter(([type]) => type === "keydown");
    expect(keydowns).toHaveLength(1);

    press({ key: "k", ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
    root = null;
    expect(remove.mock.calls.filter(([type]) => type === "keydown").map(([, listener]) => listener)).toEqual([keydowns[0]?.[1]]);
    const after = press({ key: "k", ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(after.defaultPrevented).toBe(false);
  });
});
