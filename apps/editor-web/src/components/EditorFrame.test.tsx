// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import { EditorFrame, type FrameInitial } from "./EditorFrame";

const nav = vi.hoisted(() => ({ pathname: "/", search: "", push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

/** jsdom に無い IntersectionObserver の代わり。callback を手で呼んで「末尾が見えた」にする。 */
const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
class FakeIntersectionObserver {
  readonly entry: { callback: IntersectionObserverCallback; disconnected: boolean };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

let narrow = false;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  window.matchMedia = ((query: string) => ({ matches: narrow, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  nav.pathname = "/";
  nav.search = "";
  narrow = false;
  observers.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const NOW = Date.parse("2026-10-31T03:00:00.000Z");

function page(id: string, title = id): PageSummary {
  return { id, kind: "note", title, lang: "ja", parent: null, stepStatus: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-31T02:00:00.000Z", publication: null };
}

async function mount(initial: Partial<FrameInitial> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const value: FrameInitial = { pages: [], next: null, now: NOW, me: { name: "開発ユーザー", caption: "stub", initial: "開" }, initialNarrow: false, ...initial };
  await act(async () => root!.render(<EditorFrame initial={value}>{<p>合成の中身</p>}</EditorFrame>));
  return container;
}

const rows = () => [...container!.querySelectorAll(".es-sb-list li .es-di-t")].map((node) => node.textContent);
const shell = () => container!.querySelector<HTMLElement>("[data-editor-shell]")!.dataset;
const click = (selector: string) => act(async () => container!.querySelector<HTMLElement>(selector)!.click());
const intersect = () => act(async () => observers.filter((entry) => !entry.disconnected).at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));

function chunkResponse(pages: PageSummary[], next: string | null): Response {
  return new Response(JSON.stringify({ pages, next }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("EditorFrame", () => {
  it("loads the next chunk when the end of the list comes near, one request at a time, deduped, until next is null", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mount({ pages: [page("a"), page("b")], next: "cursor-1" });
      expect(rows()).toEqual(["a", "b"]);
      await intersect();
      await intersect();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/pages?limit=100&cursor=cursor-1");
      await act(async () => release(chunkResponse([page("b"), page("c")], "cursor-2")));
      expect(rows()).toEqual(["a", "b", "c"]);

      await intersect();
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/pages?limit=100&cursor=cursor-2");
      await act(async () => release(chunkResponse([page("d")], null)));
      expect(rows()).toEqual(["a", "b", "c", "d"]);
      expect(observers.every((entry) => entry.disconnected)).toBe(true);
      expect(container!.querySelector('.es-sb-list > [aria-hidden="true"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    }
  });

  it("stops after a failed request and tries again on the next intersection", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(chunkResponse([page("b")], null));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mount({ pages: [page("a")], next: "cursor-1" });
      await intersect();
      expect(rows()).toEqual(["a"]);
      await intersect();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(rows()).toEqual(["a", "b"]);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    }
  });

  it("moves to a page, a new page, the recording start, and the settings from the sidebar", async () => {
    nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名"), page("00000000-0000-4000-8000-000000000002")] });
    expect(container!.querySelector(".es-ttl")?.textContent).toBe("合成の題名");
    expect(container!.querySelector('[aria-current="page"]')?.textContent).toContain("合成の題名");

    await act(async () => container!.querySelectorAll<HTMLButtonElement>(".es-sb-list li button")[1]!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/00000000-0000-4000-8000-000000000002");

    await click('button[aria-label="新しいページ"]');
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("空のページ"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    await click('button[aria-label="新しいページ"]');
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("録音から"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new?from=recording");

    await click(".es-sb-me");
    const items = [...container!.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["発信先", "役割とつながり", "設定", "ログアウト"]);
    await act(async () => items[2]!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/settings");

    // デスクトップ: 一覧をしまうとヘッダーの左に「一覧を出す」
    await click('button[aria-label="一覧をしまう"]');
    expect(shell().sidebar).toBe("closed");
    await click('button[aria-label="一覧を出す"]');
    expect(shell().sidebar).toBe("open");
  });

  describe("search (#35)", () => {
    const hit = (id: string, title: string, snippet: string) => ({ id, kind: "note", title, snippet, updatedAt: "2026-10-31T02:30:00.000Z" });
    const searchResponse = (results: unknown[], status = 200): Response =>
      new Response(JSON.stringify(status === 200 ? { results } : { error: "unavailable" }), { status, headers: { "content-type": "application/json" } });
    const type = async (value: string) => {
      const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // usePageSearch の待ち（150ms）と、その応答
      await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    };
    const pressK = (init: KeyboardEventInit = { ctrlKey: true }) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init })));
    const note = () => container!.querySelector(".es-sb-list [role=\"status\"]")?.textContent;
    const searchInput = () => container!.querySelector<HTMLInputElement>('[role="search"] input[type="search"]');

    afterEach(() => vi.unstubAllGlobals());

    it("searches the server (title and body) while typing and shows the matched sentence; the plain list returns when the query is cleared", async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => searchResponse([hit("h1", "鎌倉の朝", "…江ノ電の音で目が覚めた…"), hit("h2", "メモ", "朝の散歩の前に")]));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
      await mount({ pages: [page("a", "日記"), page("b", "録音")], next: "cursor-1" });
      expect(rows()).toEqual(["日記", "録音"]);
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).not.toBeNull();

      await click('button[aria-label="探す"]');
      await type("朝");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^\/api\/search\?q=/);
      expect(rows()).toEqual(["鎌倉の朝", "メモ"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["…江ノ電の音で目が覚めた…", "朝の散歩の前に"]);
      expect(note()).toBe("2 件");
      // 検索中は続きを読まない
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).toBeNull();

      await type("");
      expect(rows()).toEqual(["日記", "録音"]);
      expect(note()).toBeUndefined();
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).not.toBeNull();
    });

    it("says so when nothing is found, and when the search fails", async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>().mockResolvedValueOnce(searchResponse([])).mockResolvedValueOnce(searchResponse([], 503));
      vi.stubGlobal("fetch", fetchMock);
      await mount({ pages: [page("a", "日記")] });
      await click('button[aria-label="探す"]');
      await type("ない");
      expect(rows()).toEqual([]);
      expect(note()).toBe("見つかりませんでした");
      await type("ない2");
      expect(note()).toBe("いま検索できません。しばらくしてからもう一度");
    });

    it("opens and focuses the search with the keyboard (Ctrl+K here; ⌘K on a Mac), also when it is already open", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => searchResponse([])));
      await mount({ pages: [page("a", "日記")] });
      expect(searchInput()).toBeNull();
      await pressK();
      expect(searchInput()).not.toBeNull();
      expect(document.activeElement).toBe(searchInput());

      await act(async () => searchInput()!.blur());
      expect(document.activeElement).not.toBe(searchInput());
      await pressK();
      expect(document.activeElement).toBe(searchInput());
      // 他の組み合わせでは開かない
      await click('button[aria-label="やめる"]');
      await pressK({ ctrlKey: true, shiftKey: true });
      await pressK({ metaKey: true });
      expect(searchInput()).toBeNull();
    });

    it("shows a folded list first: desktop (list closed) and narrow (page open)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => searchResponse([])));
      await mount({ pages: [page("a", "日記")] });
      await click('button[aria-label="一覧をしまう"]');
      expect(shell().sidebar).toBe("closed");
      await pressK();
      expect(shell().sidebar).toBe("open");
      expect(document.activeElement).toBe(searchInput());
      await act(async () => root!.unmount());

      narrow = true;
      nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
      await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
      expect(shell().view).toBe("page");
      await pressK();
      expect(shell().view).toBe("list");
      expect(document.activeElement).toBe(searchInput());
    });
  });

  it("narrow: / is the list, a page is full screen with a list button, and picking the current row closes the list", async () => {
    narrow = true;
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("list");
    expect(container!.querySelector('button[aria-label="一覧をしまう"]')).toBeNull();
    await act(async () => root!.unmount());

    nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("page");
    await click('button[aria-label="一覧を出す"]');
    expect(shell().view).toBe("list");
    await click('[aria-current="page"]');
    expect(shell().view).toBe("page");
    expect(nav.push).not.toHaveBeenCalled();

    nav.pathname = "/settings";
    await act(async () => root!.render(<EditorFrame initial={{ pages: [], next: null, now: NOW, me: { name: "x", caption: "", initial: "x" }, initialNarrow: true }}>{null}</EditorFrame>));
    expect(container!.querySelector(".es-ttl")?.textContent).toBe("設定");
    expect(container!.querySelector(".es-dt--plain")).not.toBeNull();
  });
});
