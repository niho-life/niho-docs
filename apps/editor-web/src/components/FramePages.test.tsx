// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditorProps = { page?: { id: string | null; lang?: string }; onCreated?: (id: string) => void; onLangChange?: (lang: "ja" | "en") => void };
const editors: EditorProps[] = [];
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), pageLangChanged: vi.fn(), narrow: false };

vi.mock("next/navigation", () => ({ usePathname: () => "/p/new", useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame, isNarrowNow: () => false }));
vi.mock("@/lib/last-page", () => ({ rememberLastPage: vi.fn() }));
vi.mock("./PageEditor", () => ({
  PageEditor: (props: EditorProps) => {
    editors.push(props);
    return null;
  },
}));

import { rememberLastPage } from "@/lib/last-page";
import { NewPage, OpenPage } from "./FramePages";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  editors.length = 0;
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/p/new");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NewPage />);
  });
}

describe("NewPage: the creation redirect belongs to the draft that made the page", () => {
  it("replaces /p/new with /p/{id} while the draft that created the page is still on screen", async () => {
    await mount();
    await act(async () => editors.at(-1)!.onCreated!("11111111-1111-4111-8111-111111111111"));
    expect(window.location.pathname).toBe("/p/11111111-1111-4111-8111-111111111111");
    expect(rememberLastPage).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("does not touch the URL when the draft was already left (the POST finishes after the user moved on)", async () => {
    await mount();
    const created = editors.at(-1)!.onCreated!;
    // 「録音から」へ移る・別の下書きへ戻るなどで、この下書きのエディタが外れる。URL は `/p/new` のまま
    await act(async () => root!.unmount());
    root = null;
    created("22222222-2222-4222-8222-222222222222");
    expect(window.location.pathname).toBe("/p/new");
    expect(rememberLastPage).not.toHaveBeenCalled();
    // ページは作られているので、一覧には載せる
    expect(frame.pageCreated).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "");
  });
});

describe("OpenPage: the language and the recording length for the info panel", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  const summary = { id: ID, kind: "rec" as const, title: "合成の録音", lang: "en" as const, parent: null, stepStatus: null, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" };

  it("opens the editor in the page's language, tells the frame the recording length, and reports a saved language change to the list", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={summary} blocks={[]} revision={3} recordingSec={878} />);
    });
    expect(editors.at(-1)?.page).toMatchObject({ id: ID, lang: "en" });
    expect(frame.pageOpened).toHaveBeenCalledWith(summary, { recordingSec: 878 });
    await act(async () => editors.at(-1)!.onLangChange!("ja"));
    expect(frame.pageLangChanged).toHaveBeenCalledWith(ID, "ja");
  });

  it("passes no recording length when the server did not read one", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={{ ...summary, kind: "note" }} blocks={[]} revision={3} />);
    });
    expect(frame.pageOpened).toHaveBeenCalledWith({ ...summary, kind: "note" }, { recordingSec: null });
  });
});

describe("NewPage: a language saved after the page was created goes to the list", () => {
  it("reports the language for the created page only", async () => {
    await mount();
    await act(async () => editors.at(-1)!.onLangChange!("en"));
    expect(frame.pageLangChanged).not.toHaveBeenCalled();
    await act(async () => editors.at(-1)!.onCreated!("44444444-4444-4444-8444-444444444444"));
    await act(async () => editors.at(-1)!.onLangChange!("en"));
    expect(frame.pageLangChanged).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444", "en");
  });
});
