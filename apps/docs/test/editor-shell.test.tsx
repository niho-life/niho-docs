// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import { projectPages } from "@niho/docs-core";
import { MAC_DOCS_CAPABILITIES } from "niho-docs-ui/host/DocsHost";
import { click, renderApp, settle, typeInto, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";

/**
 * 新しい editor の画面（#45 第 1 段）: Web と同じ shell の枠と同じ本文のエディタで、保管庫のページを一覧して書く。
 * 旧い画面は既定のまま（capability を立てたときだけ新しい画面になる）。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function editorBridge(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.capabilities = { ...MAC_DOCS_CAPABILITIES, editorShell: true };
  return bridge;
}

async function render(bridge: FakeBridge): Promise<Screen> {
  screen = await renderApp(bridge, { autoOpen: false, openChat: false });
  return screen;
}

function shell(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".es-root[data-editor-shell]");
  if (!root) throw new Error("新しい画面の枠が出ていません");
  return root;
}

function rows(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".es-sb-list .es-di")];
}

function title(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>("textarea.page-title");
  if (!element) throw new Error("題名の欄が出ていません");
  return element;
}

function body(container: HTMLElement): Editor {
  const element = container.querySelector(".be .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("本文のエディタが出ていません");
  return element.editor;
}

/** ＋ ›「空のページ」。 */
async function newPage(container: HTMLElement) {
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="新しいページ"]')!);
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button, [role="menuitem"]')].find(
    (candidate) => candidate.textContent?.includes("空のページ"),
  );
  if (!item) throw new Error("「空のページ」が出ていません");
  await click(item);
}

/** 自動保存（250ms・最大 1 秒）を待つ。 */
async function waitSave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  await settle();
}

describe("Mac の新しい editor の画面", () => {
  it("枠（1 段のヘッダー・左の一覧・本人の行）を出す", async () => {
    const { container } = await render(editorBridge());
    expect(shell(container).querySelector(".es-sb")).not.toBeNull();
    expect(shell(container).querySelector(".es-dt")).not.toBeNull();
    expect(container.querySelector('button[aria-label="新しいページ"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="探す"]')).not.toBeNull();
    // ＋と探すの他に、絞り込みの帯（すべて／公開中／録音）は持たない
    expect(container.textContent).not.toContain("公開中");
  });

  it("空のページを作り、題名と本文を保管庫の Markdown に保存する", async () => {
    const bridge = editorBridge();
    const { container } = await render(bridge);
    await newPage(container);
    await typeInto(title(container), "新しい下書き");
    await act(async () => {
      body(container).commands.insertContent("保管庫に入る本文");
    });
    await waitSave();

    const page = projectPages(bridge.outside.project).find((candidate) => candidate.kind === "doc");
    expect(page?.title).toBe("新しい下書き");
    expect(bridge.outside.docs[page!.id]).toContain("保管庫に入る本文");
    expect(rows(container)[0]?.textContent).toContain("新しい下書き");
  });

  it("見出し・箇条書き・囲みを Markdown にして保存する", async () => {
    const bridge = editorBridge();
    const { container } = await render(bridge);
    await newPage(container);
    await act(async () => {
      const editor = body(container);
      editor.commands.insertContent("見出し");
      editor.commands.setNode("heading", { level: 2 });
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "囲みの中" }] }] });
    });
    await waitSave();

    const page = projectPages(bridge.outside.project).find((candidate) => candidate.kind === "doc");
    const markdown = bridge.outside.docs[page!.id] ?? "";
    expect(markdown).toContain("## 見出し");
    expect(markdown).toContain("> [!note]");
    expect(markdown).toContain("囲みの中");
  });

  it("保管庫のページを開いて本文を読み、続きを同じファイルに保存する", async () => {
    const bridge = editorBridge();
    const created = await bridge.createPage(null, { kind: "doc", title: "前に書いた", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await bridge.writePage(null, created.id, "## もとの見出し\n\nもとの本文\n");
    const { container } = await render(bridge);
    expect(rows(container).length).toBe(1);

    await click(rows(container)[0]!);
    expect(body(container).getText()).toContain("もとの本文");

    await act(async () => {
      body(container).commands.insertContentAt(body(container).state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "足した段落" }] });
    });
    await waitSave();
    const markdown = bridge.outside.docs[created.id] ?? "";
    expect(markdown).toContain("## もとの見出し");
    expect(markdown).toContain("足した段落");
  });

  it("限定 AST の外の要素があるページは、黙って欠けさせず開かずに知らせる", async () => {
    const bridge = editorBridge();
    const created = await bridge.createPage(null, { kind: "doc", title: "表のあるページ", createdAt: new Date().toISOString() });
    await bridge.writePage(null, created.id, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    const { container } = await render(bridge);
    await click(rows(container)[0]!);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("開けない要素");
    expect(container.querySelector("textarea.page-title")).toBeNull();
    // 本文のファイルは変えない
    expect(bridge.outside.docs[created.id]).toContain("| a | b |");
  });

  it("capability が無ければ旧い画面のまま", async () => {
    const { container } = await render(new FakeBridge());
    expect(container.querySelector(".es-root[data-editor-shell]")).toBeNull();
    expect(container.querySelector(".rail")).not.toBeNull();
  });
});
