// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import { SAVE_STATUS_TEXT, type SaveStatus } from "@/lib/save-status";
import { EditorFrame, useEditorFrame, type AttachedPage, type FrameInitial } from "./EditorFrame";
import { PageEditor } from "./PageEditor";

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
  // jsdom に無い描画の API（本物の PageEditor を枠に入れるテストで、ProseMirror と浮かぶメニューが読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
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

let mounted: FrameInitial | null = null;

async function mount(initial: Partial<FrameInitial> = {}, children: ReactNode = <p>合成の中身</p>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = { pages: [], next: null, now: NOW, me: { name: "開発ユーザー", caption: "stub", initial: "開" }, initialNarrow: false, ...initial };
  await rerender(children);
  return container;
}

/** 同じ枠のまま中身（ページ）だけを替える（一覧などの枠の状態は残る）。 */
async function rerender(children: ReactNode) {
  await act(async () => root!.render(<EditorFrame initial={mounted!}>{children}</EditorFrame>));
}

/** 同じ枠のまま、nav.pathname・nav.search を替えて描き直す（画面の移動）。 */
async function moveTo(pathname: string, search = "") {
  nav.pathname = pathname;
  nav.search = search;
  await rerender(<p>合成の中身</p>);
}

/** ショートカットを押す（jsdom の platform は Mac ではないので Ctrl）。 */
async function shortcut(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const dialog = () => container!.querySelector<HTMLElement>('[role="dialog"]');
const buttonByText = (text: string, scope: ParentNode = container!) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);

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

  it("⌘N (Ctrl+N) opens a blank new page like the menu, once until it gets there, and not again on the new page", async () => {
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    const first = await shortcut("n");
    expect(first.defaultPrevented).toBe(true);
    expect(nav.push).toHaveBeenCalledWith("/p/new");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(1);

    // 新しいページ（作っている途中を含む）では作り直さない。録音からの画面からは新しいページへ
    await moveTo("/p/new");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(1);
    await moveTo("/p/new", "from=recording");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(2);

    // 移ったあと、もとのページに戻れば、また押せる
    await moveTo(`/p/${PAGE_ID}`);
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(3);
    // ⇧・⌥ 付き、IME の変換中は対象にしない
    await shortcut("N", { shiftKey: true });
    await shortcut("n", { altKey: true });
    await moveTo("/settings");
    await shortcut("n", { isComposing: true });
    expect(nav.push).toHaveBeenCalledTimes(3);
  });

  it("⌘K (Ctrl+K) brings the list back and focuses the search field, also when the search is already open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    await mount({ pages: [page("a", "NIHO 録音"), page("b", "日記")] });
    await click('button[aria-label="一覧をしまう"]');
    expect(shell().sidebar).toBe("closed");
    const event = await shortcut("k");
    expect(event.defaultPrevented).toBe(true);
    expect(shell().sidebar).toBe("open");
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "日記");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    await shortcut("k");
    // 開いていた検索の入力を残したまま、もう一度フォーカスする（検索の結果はサーバーが返す。ここでは絞り込まない）
    const again = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(again);
    expect(again.value).toBe("日記");
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  it("narrow: ⌘K on a page shows the list screen with the search field focused", async () => {
    narrow = true;
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("page");
    await shortcut("k");
    expect(shell().view).toBe("list");
    expect(document.activeElement).toBe(container!.querySelector('input[type="search"]'));
  });

  it("⌘⇧P and the header's 公開 open the publish sheet on a page only, and Esc closes it back to where it was opened", async () => {
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    // 一覧・設定・新しいページ・録音からでは出さず、キーはブラウザに任せる
    for (const [path, search] of [["/", ""], ["/settings", ""], ["/p/new", ""], ["/p/new", "from=recording"]] as const) {
      await moveTo(path, search);
      expect(buttonByText("公開"), path).toBeUndefined();
      const ignored = await shortcut("P", { shiftKey: true });
      expect(ignored.defaultPrevented, path).toBe(false);
      expect(dialog(), path).toBeNull();
    }

    await moveTo(`/p/${PAGE_ID}`);
    const opener = buttonByText("公開")!;
    await act(async () => opener.focus());
    const event = await shortcut("P", { shiftKey: true }, opener);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
    expect(container!.querySelector(".es-root")!.contains(dialog())).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await act(async () => opener.click());
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
    // 開いているあいだ、⌘N・⌘K は使わない
    await shortcut("n");
    await shortcut("k");
    expect(nav.push).not.toHaveBeenCalled();
    expect(container!.querySelector('input[type="search"]')).toBeNull();
    // 別の画面へ移ったら閉じる
    await moveTo("/settings");
    await moveTo(`/p/${PAGE_ID}`);
    expect(dialog()).toBeNull();
  });

  it("narrow: ⌘⇧P does nothing while the list is shown over the page", async () => {
    narrow = true;
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")], initialNarrow: true });
    await click('button[aria-label="一覧を出す"]');
    expect(shell().view).toBe("list");
    expect((await shortcut("P", { shiftKey: true })).defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("the sheet shows every destination as not connected, so nothing is selectable and 公開する cannot be pressed", async () => {
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    await act(async () => buttonByText("公開")!.click());
    const sheet = dialog()!;
    expect(sheet.querySelectorAll('[role="radio"][aria-checked]').length).toBe(0);
    expect(sheet.textContent).not.toContain("条件はそろっています");
    const connect = [...sheet.querySelectorAll("button")].filter((button) => button.textContent?.includes("接続する"));
    expect(connect.map((button) => button.querySelector("b")?.textContent)).toEqual(["NIHO Experience", "NIHO", "自分のサイト"]);
    expect(buttonByText("公開する", sheet)?.disabled).toBe(true);
    expect(container!.querySelector("[data-publish-notice]")?.textContent).toBe("");
  });

  it("発信先を追加 and 接続する lead to the destinations settings", async () => {
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    await act(async () => buttonByText("公開")!.click());
    await act(async () => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent?.includes("発信先を追加"))!.click());
    expect(dialog()?.getAttribute("aria-label")).toBe("発信先を追加");
    await act(async () => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent?.includes("WordPress"))!.click());
    expect(dialog()).toBeNull();
    expect(nav.push).toHaveBeenLastCalledWith("/destinations");

    await act(async () => buttonByText("公開")!.click());
    await act(async () => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent?.includes("接続する"))!.click());
    expect(dialog()).toBeNull();
    expect(nav.push).toHaveBeenCalledTimes(2);
  });

  it("a page opens the publish sheet through useEditorFrame().openPublish", async () => {
    function OpenFromPage() {
      const { openPublish } = useEditorFrame();
      return (
        <button type="button" onClick={openPublish}>
          ページから公開
        </button>
      );
    }
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] }, <OpenFromPage />);
    await act(async () => buttonByText("ページから公開")!.click());
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
  });
});

describe("EditorFrame: the header's state and the … menu (#34)", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const C = "00000000-0000-4000-8000-00000000000c";
  const D = "00000000-0000-4000-8000-00000000000d";
  const COPY = "00000000-0000-4000-8000-0000000000c0";
  const UPDATED_AT = "2026-10-31T02:00:00.000Z";

  /** ページの中の PageEditor の代わり。渡した状態のまま枠に登録する。 */
  function FakePage({ page: attached }: { page: AttachedPage }) {
    const { attachPage } = useEditorFrame();
    useEffect(() => attachPage(attached), [attachPage, attached]);
    return <p>合成の本文</p>;
  }
  function fakePage(id: string | null, over: Partial<AttachedPage> = {}): AttachedPage {
    return { id, status: "saved", flush: vi.fn(async () => true), ...over };
  }
  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((ok, ng) => {
      resolve = ok;
      reject = ng;
    });
    return { promise, resolve, reject };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const tip = () => container!.querySelector(".es-dt .es-st-tip")?.textContent;
  const dot = () => container!.querySelector(".es-dt .es-st");
  const moreButton = () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="その他"]');
  const menu = () => container!.querySelector<HTMLElement>('[role="menu"][aria-label="その他"]');
  const menuItems = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const headerAlert = () => container!.querySelector(".es-dt [role=\"alert\"]")?.textContent;
  const dialog = () => container!.querySelector<HTMLElement>('[role="dialog"]');
  const dialogAlert = () => dialog()?.querySelector('[role="alert"]')?.textContent;
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === label)!;
  const press = (target: Element, key: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  async function choose(label: string) {
    await act(async () => moreButton()!.click());
    await act(async () => menuItems().find((item) => item.textContent?.startsWith(label))!.click());
    await tick();
  }

  beforeEach(() => {
    nav.pathname = `/p/${A}`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.restoreAllMocks();
  });

  it("shows the open page's save state as 「自分だけ」 (no publish state; the 公開 button is the frame's, #43), and nothing outside a page", async () => {
    const a = fakePage(A);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={a} />);
    expect(dot()?.classList.contains("es-st--private")).toBe(true);
    expect(tip()).toBe("自分だけ · 保存済み");
    expect(container!.querySelector(".es-dt .es-st-wrap")?.getAttribute("aria-live")).toBe("polite");
    // 公開ボタンは枠（#43）が出す。丸は公開の状態を出さない
    expect(container!.querySelector(".es-pubbtn")).not.toBeNull();

    await rerender(<FakePage page={{ ...a, status: "saving" }} />);
    expect(tip()).toBe("自分だけ · 保存中");
    await rerender(<FakePage page={{ ...a, status: "offline" }} />);
    expect(tip()).toBe("自分だけ · オフライン・この端末に保持");
    for (const status of ["error", "conflict", "signedOut"] as SaveStatus[]) {
      await rerender(<FakePage page={{ ...a, status }} />);
      expect(tip()).toBe(`自分だけ · ${SAVE_STATUS_TEXT[status]}`);
      // 公開の状態（公開中・更新あり・限定公開・公開をやめた）は出さない
      expect(dot()?.classList.contains("es-st--private")).toBe(true);
    }

    // ページを離れたら（設定）、状態も「…」も出さない
    nav.pathname = "/settings";
    await rerender(null);
    expect(dot()).toBeNull();
    expect(moreButton()).toBeNull();
  });

  it("opens and closes the … menu with only 書き出し (.md), 複製 and 削除, moved by the keyboard; none for a page not created yet", async () => {
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => moreButton()!.click());
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("true");
    // 共有・履歴は次の段、Google ドキュメントは出さない
    expect(menuItems().map((item) => item.textContent)).toEqual(["書き出し.md", "複製", "削除"]);
    const [exportItem, duplicateItem, deleteItem] = menuItems();
    expect(document.activeElement).toBe(exportItem);
    await press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(duplicateItem);
    await press(document.activeElement!, "End");
    expect(document.activeElement).toBe(deleteItem);
    await press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(exportItem);
    await press(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    await act(async () => moreButton()!.click());
    await act(async () => moreButton()!.click());
    expect(menu()).toBeNull();

    // まだ作っていない新しいページ（/p/new）: 状態は出し、「…」は出さない
    nav.pathname = "/p/new";
    await rerender(<FakePage page={fakePage(null)} />);
    expect(tip()).toBe("自分だけ · 保存済み");
    expect(moreButton()).toBeNull();
  });

  it("duplicate: saves first, then POSTs, puts the copy on top of the list and moves to it", async () => {
    const calls: string[] = [];
    const a = fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return json(201, { page: { id: COPY, kind: "note", title: "合成の題名のコピー", lang: "ja", blocks: [], parent: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT } });
      }),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={a} />);
    await choose("複製");
    expect(calls).toEqual(["flush", `POST /api/pages/${A}/duplicate`]);
    expect(rows()).toEqual(["合成の題名のコピー", "合成の題名", "別のページ"]);
    expect(nav.push).toHaveBeenCalledWith(`/p/${COPY}`);
    expect(document.activeElement).toBe(moreButton());
    expect(headerAlert()).toBeUndefined();
  });

  it("duplicate: a failure says so next to …, stays on the page, and the note goes when the menu opens again", async () => {
    const fetchMock = vi.fn(async () => json(500, { error: "internal" })).mockResolvedValueOnce(json(500, { error: "internal" })).mockResolvedValueOnce(json(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    await choose("複製");
    expect(headerAlert()).toBe("複製できませんでした");
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => moreButton()!.click());
    expect(headerAlert()).toBeUndefined();
    await act(async () => menuItems()[1]!.click());
    await tick();
    expect(headerAlert()).toBe("ログインし直してください");
  });

  it("does one action at a time on a page: a second 複製 while the first is saving is not sent", async () => {
    const saving = deferred<boolean>();
    const flush = vi.fn(() => saving.promise);
    const fetchMock = vi.fn(async () => json(201, { page: { id: COPY, title: "合成の題名のコピー", kind: "note" } }));
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush })} />);
    await choose("複製");
    await choose("複製");
    expect(flush).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve(true));
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  it("export: saves first, then clicks a same-origin download link to export.md (the body is not fetched)", async () => {
    const calls: string[] = [];
    const links: Array<{ href: string | null; download: string | null; connected: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      calls.push("click");
      links.push({ href: this.getAttribute("href"), download: this.getAttribute("download"), connected: this.isConnected });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    await choose("書き出し");
    expect(calls).toEqual(["flush", "click"]);
    expect(links).toEqual([{ href: `/api/pages/${A}/export.md`, download: "", connected: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("stops every action when the unsaved edits cannot be saved, and says why (nothing is sent, the list stays)", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { status: "offline", flush: vi.fn(async () => false) })} />);
    await choose("書き出し");
    expect(headerAlert()).toBe("書き出しの前に変更を保存できませんでした");
    expect(click).not.toHaveBeenCalled();
    await choose("複製");
    expect(headerAlert()).toBe("複製の前に変更を保存できませんでした");
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(dialogAlert()).toBe("削除の前に変更を保存できませんでした");
    expect(dialog()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("delete: asks first, then saves and DELETEs, takes the page and its loaded subpages out of the list, and goes to /", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    const pages = [{ ...page(C, "手順の結果"), parent: A }, page(A, "合成の題名"), page(D, "別のページ")];
    await mount({ pages }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    expect(rows()).toEqual(["合成の題名", "手順の結果", "別のページ"]);
    await choose("削除");
    // 確認だけでは何も送らない
    expect(calls).toEqual([]);
    expect(dialog()?.getAttribute("aria-label")).toBe("ページの削除");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("このページを削除しますか？");
    expect(dialog()?.textContent).toContain("ゴミ箱に 30 日残ります。");
    expect(document.activeElement).toBe(dialogButton("やめる"));
    expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(true);

    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(calls).toEqual(["flush", `DELETE /api/pages/${A}`]);
    expect(dialog()).toBeNull();
    expect(rows()).toEqual(["別のページ"]);
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it("delete: sends once while waiting (Esc and やめる do not close it then), and a refusal stays in the dialog with the list unchanged", async () => {
    const answers = [deferred<Response>(), deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let call = 0;
    const fetchMock = vi.fn(() => answers[call++]!.promise);
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dialogButton("削除する").getAttribute("aria-disabled")).toBe("true");
    await press(document.activeElement!, "Escape");
    await act(async () => dialogButton("やめる").click());
    expect(dialog()).not.toBeNull();

    // 公開中のページは消さない（設計 §12）
    await act(async () => answers[0]!.resolve(json(409, { error: "published" })));
    await tick();
    expect(dialogAlert()).toBe("公開中のページは、先に公開をやめてください");
    expect(dialogButton("削除する").getAttribute("aria-disabled")).toBeNull();
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();

    await act(async () => dialogButton("削除する").click());
    await act(async () => answers[1]!.resolve(json(500, { error: "internal" })));
    await tick();
    expect(dialogAlert()).toBe("削除できませんでした");
    await act(async () => dialogButton("削除する").click());
    await act(async () => answers[2]!.reject(new TypeError("Failed to fetch")));
    await tick();
    expect(dialogAlert()).toBe("削除できませんでした");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // やめる: 閉じて「…」へフォーカスが戻り、外の inert も外れる
    await act(async () => dialogButton("やめる").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(false);
    expect(rows()).toEqual(["合成の題名"]);

    // Esc でも閉じる
    await choose("削除");
    await press(document.activeElement!, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("delete: also takes the page out of the search results on screen", async () => {
    const hit = (id: string, title: string) => ({ id, kind: "note", title, snippet: "朝", updatedAt: UPDATED_AT });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.startsWith("/api/search") ? json(200, { results: [hit(A, "合成の題名"), hit(D, "別のページ")] }) : new Response(null, { status: 204 }))),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A)} />);
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="探す"]')!.click());
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "朝");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["合成の題名", "別のページ"]);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(rows()).toEqual(["別のページ"]);
    expect(container!.querySelector('.es-sb-list [role="status"]')?.textContent).toBe("1 件");
  });

  it("delete: asks the server for the search results again, so a subpage that was never loaded goes too", async () => {
    const E = "00000000-0000-4000-8000-00000000000e";
    const hit = (id: string, title: string) => ({ id, kind: "note", title, snippet: "朝", updatedAt: UPDATED_AT });
    let deleted = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      // サーバーは、削除したページの下のページも削除済み。削除の前の答えには E（読み込んでいない子ページ）が載っている
      return json(200, { results: deleted ? [hit(D, "別のページ")] : [hit(A, "合成の題名"), hit(E, "手順の結果"), hit(D, "別のページ")] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A)} />);
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="探す"]')!.click());
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "朝");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["合成の題名", "手順の結果", "別のページ"]);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    // 消したと分かっているページはすぐ外れ、そのあとサーバーの新しい答えで、読み込んでいなかった子ページも外れる
    expect(rows()).toContain("別のページ");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["別のページ"]);
    expect(container!.querySelector('.es-sb-list [role="status"]')?.textContent).toBe("1 件");
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/search"))).toHaveLength(2);
  });

  it("delete: a page chunk requested before the delete does not bring the page or its subpages back", async () => {
    const E = "00000000-0000-4000-8000-00000000000e";
    const F = "00000000-0000-4000-8000-00000000000f";
    const chunk = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : chunk.promise)),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")], next: "cursor-1" }, <FakePage page={fakePage(A)} />);
    await intersect();
    // 要求の途中で A を削除する
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(rows()).toEqual(["別のページ"]);
    // 削除の前の一覧が返ってくる: A、A の子 E、E の子 F（子が親より先に並ぶこともある）、関係ない C
    await act(async () =>
      chunk.resolve(chunkResponse([{ ...page(F, "孫"), parent: E }, { ...page(E, "子"), parent: A }, page(A, "合成の題名"), page(C, "関係ないページ")], null)),
    );
    expect(rows()).toEqual(["別のページ", "関係ないページ"]);
  });

  it("acts on the page the … belongs to: after moving to another page, an old result neither moves nor shows there", async () => {
    const answer = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => answer.promise));
    await mount({ pages: [page(A, "合成の題名"), page(B, "次のページ")] }, <FakePage page={fakePage(A)} />);
    await choose("複製");
    nav.pathname = `/p/${B}`;
    const b = fakePage(B);
    await rerender(<FakePage page={b} />);
    await act(async () => answer.resolve(json(201, { page: { id: COPY, title: "合成の題名のコピー", kind: "note" } })));
    await tick();
    // 複製はできているので一覧には足す。移動はしない
    expect(rows()).toEqual(["合成の題名のコピー", "合成の題名", "次のページ"]);
    expect(nav.push).not.toHaveBeenCalled();

    // 失敗も、移った先のページには出さない
    const failing = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => failing.promise));
    await choose("複製");
    nav.pathname = `/p/${A}`;
    await rerender(<FakePage page={fakePage(A)} />);
    await act(async () => failing.resolve(json(500, { error: "internal" })));
    await tick();
    expect(headerAlert()).toBeUndefined();

    // 削除の確認は、そのページを離れたら消える。送った削除の結果は一覧には出すが、移った先から動かない
    const deleting = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => deleting.promise));
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    nav.pathname = `/p/${B}`;
    await rerender(<FakePage page={b} />);
    expect(dialog()).toBeNull();
    await act(async () => deleting.resolve(new Response(null, { status: 204 })));
    await tick();
    expect(rows()).toEqual(["合成の題名のコピー", "次のページ"]);
    expect(nav.push).not.toHaveBeenCalled();
    // 移った先の「…」はふつうに使える
    await act(async () => moreButton()!.click());
    expect(menuItems()).toHaveLength(3);
  });

  describe("with the real PageEditor", () => {
    const typeTitle = async (value: string) => {
      const title = container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("registers the page: the dot follows the real save state and is the only live region saying it; 複製 sends the unsaved title first", async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const body = init.body ? JSON.parse(String(init.body)) : null;
          calls.push({ method: String(init.method), url, body });
          if (init.method === "PATCH") return json(200, { page: { id: A, revision: 2 } });
          return json(201, { page: { id: COPY, title: "合成の題名 2のコピー", kind: "note" } });
        }),
      );
      await mount(
        { pages: [page(A, "合成の題名")] },
        <PageEditor page={{ id: A, title: "合成の題名", blocks: [], revision: 1, updatedAt: UPDATED_AT }} drafts={null} />,
      );
      await tick();
      expect(tip()).toBe("自分だけ · 保存済み");
      const saying = [...container!.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')].filter((node) => node.textContent?.includes("保存済み"));
      expect(saying).toEqual([container!.querySelector(".es-dt .es-st-wrap")]);
      // 本文の上の表示は残す（見える文字だけ）
      expect(container!.querySelector("[data-save-state]")?.textContent).toBe("保存済み");

      await typeTitle("合成の題名 2");
      expect(tip()).toBe("自分だけ · 保存中");
      // 1 秒の自動保存を待たずに、複製の前に送る
      await choose("複製");
      await tick();
      expect(calls).toEqual([
        { method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 1 } },
        { method: "POST", url: `/api/pages/${A}/duplicate`, body: null },
      ]);
      expect(tip()).toBe("自分だけ · 保存済み");
      expect(nav.push).toHaveBeenCalledWith(`/p/${COPY}`);
    });

    it("a new page shows the state but no … until the first save has created it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const NEW = "00000000-0000-4000-8000-0000000000ee";
        vi.stubGlobal("fetch", vi.fn(async () => json(201, { page: { id: NEW, revision: 1 } })));
        nav.pathname = "/p/new";
        await mount({ pages: [] }, <PageEditor page={{ id: null, title: "", blocks: [], revision: null }} drafts={null} />);
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(moreButton()).toBeNull();
        await typeTitle("合成の新しいページ");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(moreButton()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
