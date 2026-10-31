// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditorProps = { onCreated?: (id: string) => void };
const editors: EditorProps[] = [];
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), narrow: false };

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

describe("OpenPage: a recording page shows the transcript above the title and body", () => {
  const PAGE = "33333333-3333-4333-8333-333333333333";
  const summary = (kind: "note" | "rec") => ({ id: PAGE, kind, title: "録音", lang: "ja" as const, parent: null, stepStatus: null, publication: null, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" });

  async function open(kind: "note" | "rec") {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={summary(kind)} blocks={[]} revision={1} />);
    });
    return container;
  }

  it("puts the transcript (kind=rec) before the page editor", async () => {
    const host = await open("rec");
    expect([...host.children].map((node) => node.getAttribute("data-transcript") ?? "editor")).toEqual([PAGE, "editor"]);
    expect(frame.pageOpened).toHaveBeenCalledTimes(1);
  });

  it("shows only the editor for an ordinary page", async () => {
    const host = await open("note");
    expect([...host.children].map((node) => node.hasAttribute("data-editor"))).toEqual([true]);
    expect(host.querySelector("[data-transcript]")).toBeNull();
  });
});
