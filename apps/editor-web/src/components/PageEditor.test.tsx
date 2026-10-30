// @vitest-environment jsdom
import { createRequire } from "node:module";
import { act, version as reactVersion } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PageEditor } from "./PageEditor";

const appRequire = createRequire(import.meta.url);

/** niho-docs-ui の中から見たときの解決先（install-links で複製した node_modules/niho-docs-ui から）。 */
function resolveFromDocsUi(specifier: string): string {
  return createRequire(appRequire.resolve("niho-docs-ui/package.json")).resolve(specifier);
}

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror・浮かぶメニューの位置の計算が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("niho-docs-ui on React 19", () => {
  it("resolves react, react-dom and TipTap from niho-docs-ui to this app's single copy", () => {
    expect(reactVersion.startsWith("19.")).toBe(true);
    for (const specifier of ["react", "react-dom", "react/jsx-runtime", "@tiptap/react", "@tiptap/core", "@tiptap/pm/state", "@niho/docs-core", "niho-ui/cn"]) {
      expect(resolveFromDocsUi(specifier), specifier).toBe(appRequire.resolve(specifier));
    }
    expect(createRequire(resolveFromDocsUi("react"))("./package.json").version).toBe(reactVersion);
  });

  it("renders the docs-ui BlockEditor with the stored blocks and no invalid hook call", async () => {
    const errors = vi.spyOn(console, "error");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    await act(async () => {
      root!.render(<PageEditor page={{ id: "00000000-0000-4000-8000-000000000001", title: "合成の題名", blocks }} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const messages = errors.mock.calls.map((call) => call.map(String).join(" "));
    expect(messages.filter((message) => /Invalid hook call|more than one copy of React|older version of React/i.test(message))).toEqual([]);
    expect(container.querySelector(".be")).not.toBeNull();
    const body = container.querySelector(".ProseMirror");
    expect(body?.getAttribute("contenteditable")).toBe("true");
    expect(body?.textContent).toContain("合成の本文");
    expect(container.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("合成の題名");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("保存済み");
  });
});
