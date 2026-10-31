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
    return <div data-editor="" />;
  },
}));
vi.mock("./RecordingTranscript", () => ({
  RecordingTranscript: ({ pageId }: { pageId: string }) => <div data-transcript={pageId} />,
}));
// 手順の帯（#37）は PageSteps.test.tsx が見る。ここは、帯・文字起こし・本文の並びと渡す値だけを見る
vi.mock("./PageSteps", () => ({
  PageSteps: ({ pageId, kind, parentId, media, children }: { pageId: string; kind: string; parentId: string | null; media?: unknown; children?: unknown }) => (
    <>
      <div data-steps={`${pageId}:${kind}:${parentId ?? "none"}`} />
      {media as never}
      {children as never}
    </>
  ),
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

describe("OpenPage: the steps band, the transcript, then the title and body", () => {
  const PAGE = "33333333-3333-4333-8333-333333333333";
  const summary = (kind: "note" | "rec" | "step", parent: string | null = null) => ({ id: PAGE, kind, title: "録音", lang: "ja" as const, parent, stepStatus: null, publication: null, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" });

  async function open(kind: "note" | "rec" | "step", parent: string | null = null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={summary(kind, parent)} blocks={[]} revision={1} />);
    });
    return container;
  }

  const order = (host: HTMLElement) =>
    [...host.children].map((node) => node.getAttribute("data-steps") ?? node.getAttribute("data-transcript") ?? "editor");

  it("puts the steps band first, then the transcript (kind=rec), then the page editor", async () => {
    const host = await open("rec");
    expect(order(host)).toEqual([`${PAGE}:rec:none`, PAGE, "editor"]);
    expect(frame.pageOpened).toHaveBeenCalledTimes(1);
  });

  it("shows the band and the editor for an ordinary page, without the transcript", async () => {
    const host = await open("note");
    expect(order(host)).toEqual([`${PAGE}:note:none`, "editor"]);
    expect(host.querySelector("[data-transcript]")).toBeNull();
  });

  it("gives the band the parent of a step subpage (the run belongs to the recording page)", async () => {
    const host = await open("step", "44444444-4444-4444-8444-444444444444");
    expect(order(host)).toEqual([`${PAGE}:step:44444444-4444-4444-8444-444444444444`, "editor"]);
  });
});

describe("OpenPage: the language and the recording length for the info panel", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  const summary = { id: ID, kind: "rec" as const, title: "合成の録音", lang: "en" as const, parent: null, stepStatus: null, publication: null, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" };

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
