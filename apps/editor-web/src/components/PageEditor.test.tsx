// @vitest-environment jsdom
import { createRequire } from "node:module";
import { act, version as reactVersion } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_TITLE_CHARS } from "@/lib/page-limits";
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE_ID = "00000000-0000-4000-8000-000000000001";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 題名の欄に打つ（React の onChange を通す）。 */
function typeTitle(value: string) {
  const title = container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
  title.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderEditor(revision: number) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PageEditor page={{ id: PAGE_ID, title: "合成の題名", blocks: [], revision }} />);
  });
  // 自動保存の 1 秒だけを進める（描画の後で時計を差し替える）
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function waitForAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

describe("niho-docs-ui on React 19", () => {
  it("resolves react, react-dom and TipTap from niho-docs-ui to this app's single copy", () => {
    expect(reactVersion.startsWith("19.")).toBe(true);
    for (const specifier of ["react", "react-dom", "react/jsx-runtime", "@tiptap/react", "@tiptap/core", "@tiptap/pm/state", "@niho/docs-core", "niho-ui/cn"]) {
      expect(resolveFromDocsUi(specifier), specifier).toBe(appRequire.resolve(specifier));
    }
    expect(createRequire(resolveFromDocsUi("react"))("./package.json").version).toBe(reactVersion);
  });

  it("renders the page editor with the stored blocks and no invalid hook call", async () => {
    const errors = vi.spyOn(console, "error");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    await act(async () => {
      root!.render(<PageEditor page={{ id: "00000000-0000-4000-8000-000000000001", title: "合成の題名", blocks, revision: 1 }} />);
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

  it("caps the title at the server limit so an over-long title never enters autosave", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PageEditor page={{ id: "00000000-0000-4000-8000-000000000001", title: "合成の題名", blocks: [], revision: 1 }} />);
    });
    const title = container.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
    const set = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => set("あ".repeat(MAX_TITLE_CHARS + 1)));
    expect(Array.from(title.value)).toHaveLength(MAX_TITLE_CHARS);
    expect(container.textContent).toContain(`題名は ${MAX_TITLE_CHARS} 字までです。`);

    await act(async () => set("あ".repeat(MAX_TITLE_CHARS - 1)));
    expect(Array.from(title.value)).toHaveLength(MAX_TITLE_CHARS - 1);
    expect(container.textContent).not.toContain("字までです");
  });

  it("sends every autosave with the page's revision as baseRevision and advances it from each response", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(`/api/pages/${PAGE_ID}`);
        expect(init.method).toBe("PATCH");
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return json(200, { page: { id: PAGE_ID, revision: (body.baseRevision as number) + 1 } });
      }),
    );
    await renderEditor(5);
    await act(async () => typeTitle("一"));
    await waitForAutosave();
    await act(async () => typeTitle("一二"));
    await waitForAutosave();
    expect(bodies).toEqual([
      { title: "一", baseRevision: 5 },
      { title: "一二", baseRevision: 6 },
    ]);
    expect(container!.querySelector('[role="status"]')?.textContent).toBe("保存済み");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("stops autosave on a 409 and says so, but keeps the text editable", async () => {
    const fetchMock = vi.fn(async () =>
      json(409, { error: "conflict", page: { id: PAGE_ID, title: "別の画面", blocks: [], revision: 9, updatedAt: "2026-10-31T00:00:00.000Z" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderEditor(3);
    await act(async () => typeTitle("この画面"));
    await waitForAutosave();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe("別の画面で保存されました。このページを開き直してください。");
    expect(container!.querySelector('[role="status"]')?.textContent).toBe("保存を止めています");

    await act(async () => typeTitle("この画面の続き"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("この画面の続き");
    expect(container!.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });
});
