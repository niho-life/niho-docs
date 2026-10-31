import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiPage } from "./ai-client";
import { replaceForAi, type AiBridgeDeps } from "./ai-bridge";

const replaceBlocks = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/editor/doc", () => ({ replaceBlocks }));

const page = (revision: number, title = "題名"): AiPage => ({ id: "p1", title, blocks: [{ type: "paragraph", text: `r${revision}` }], revision }) as unknown as AiPage;

function setup(options: { revision: number; pending?: boolean; composing?: boolean }) {
  const rebase = vi.fn();
  const showTitle = vi.fn();
  const onSaved = vi.fn();
  const editor = { isDestroyed: false } as unknown as Editor;
  const deps: AiBridgeDeps = {
    editor: () => editor,
    saver: () => ({ pageId: "p1", revision: options.revision, rebase }) as never,
    autosave: () => ({ hasPending: () => options.pending ?? false }) as never,
    usable: () => true,
    isComposing: () => options.composing ?? false,
    currentTitle: () => "題名",
    showTitle,
    onSaved,
  };
  return { deps, rebase, showTitle, onSaved };
}

describe("replaceForAi", () => {
  beforeEach(() => replaceBlocks.mockClear());

  it("puts a newer page on the screen and moves the saver to its revision", async () => {
    const { deps, rebase, showTitle } = setup({ revision: 2 });
    expect(await replaceForAi(deps, page(3, "新しい題名"), { saved: false })).toBe(true);
    expect(replaceBlocks).toHaveBeenCalledTimes(1);
    expect(rebase).toHaveBeenCalledWith(3, { title: "新しい題名", blocks: page(3).blocks });
    expect(showTitle).toHaveBeenCalledWith("新しい題名");
  });

  it("puts a page of the same revision on the screen (the text is what was saved)", async () => {
    const { deps, rebase } = setup({ revision: 2 });
    expect(await replaceForAi(deps, page(2), { saved: false })).toBe(true);
    expect(rebase).toHaveBeenCalledWith(2, expect.anything());
  });

  it("ignores a page older than the saved revision: a delayed 409 must not erase text that finished saving", async () => {
    const { deps, rebase, showTitle } = setup({ revision: 3 });
    expect(await replaceForAi(deps, page(2, "古い題名"), { saved: false })).toBe(false);
    expect(replaceBlocks).not.toHaveBeenCalled();
    expect(rebase).not.toHaveBeenCalled();
    expect(showTitle).not.toHaveBeenCalled();
  });

  it("ignores the page while an input has not reached the server yet", async () => {
    const { deps, rebase } = setup({ revision: 2, pending: true });
    expect(await replaceForAi(deps, page(3), { saved: false })).toBe(false);
    expect(replaceBlocks).not.toHaveBeenCalled();
    expect(rebase).not.toHaveBeenCalled();
  });

  it("tells the page that an adoption was saved even when the page is not put on the screen", async () => {
    const { deps, onSaved } = setup({ revision: 5 });
    expect(await replaceForAi(deps, page(4), { saved: true })).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
