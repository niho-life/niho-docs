// @vitest-environment jsdom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellAddRow, ShellBubbleMenu, ShellHeader, ShellSidebar, ShellTools, StatusDot, shellAccountItems, shellMoreItems } from "./index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

const key = (target: Element | Document, name: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

describe("メニュー（Esc で閉じ、キーボードで動く）", () => {
  function Sidebar({ onPick = vi.fn() }: { onPick?: (kind: string) => void }) {
    const [open, setOpen] = useState(false);
    const [account, setAccount] = useState(false);
    return (
      <ShellSidebar
        items={[]}
        newMenu={{ open, onToggle: () => setOpen((v) => !v), onClose: () => setOpen(false), onPick }}
        me={{ name: "Mika Sato", caption: "mika@example.com", initial: "M", open: account, items: shellAccountItems(), onToggle: () => setAccount((v) => !v), onClose: () => setAccount(false), onSelect: () => setAccount(false) }}
      />
    );
  }

  it("＋で新しいページのメニュー（空のページ／録音から）が開き、先頭にフォーカス。Esc で閉じて＋へ戻る", () => {
    const onPick = vi.fn();
    const host = mount(<Sidebar onPick={onPick} />);
    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="新しいページ"]')!;
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => plus.click());
    const menu = host.querySelector('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("新しいページ");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["空のページ", "録音から"]);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("空のページ");
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("録音から");
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it("メニューの項目を選ぶと onPick（recording）が呼ばれる", () => {
    const onPick = vi.fn();
    const host = mount(<Sidebar onPick={onPick} />);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="新しいページ"]')!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "録音から")!.click());
    expect(onPick).toHaveBeenCalledWith("recording");
  });

  it("本人の行を押すと 発信先／役割とつながり／設定／ログアウト。外を押しても閉じる", () => {
    const host = mount(<Sidebar />);
    act(() => host.querySelector<HTMLButtonElement>(".es-sb-me")!.click());
    expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["発信先", "役割とつながり", "設定", "ログアウト"]);
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("ヘッダーの「…」も Esc で閉じる", () => {
    function Header() {
      const [open, setOpen] = useState(false);
      return <ShellHeader title="x" more={{ open, items: shellMoreItems(true), onToggle: () => setOpen((v) => !v), onClose: () => setOpen(false), onSelect: () => setOpen(false) }} />;
    }
    const host = mount(<Header />);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="その他"]')!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["リンクで共有共有中", "書き出し.md · Google ドキュメント", "履歴", "複製", "削除"]);
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("ブロックの一覧（＋の行）は Esc で閉じる", () => {
    function Row() {
      const [open, setOpen] = useState(true);
      return <ShellAddRow menuOpen={open} onToggle={() => setOpen(true)} onPick={() => setOpen(false)} onClose={() => setOpen(false)} />;
    }
    const host = mount(<Row />);
    expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(7);
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector('button[aria-label="ブロックを追加"]')).not.toBeNull();
  });
});

describe("状態の吹き出し", () => {
  it("フォーカスできる丸（tabindex=0）に吹き出しが結ばれ、Esc で吹き出しだけ閉じる（フォーカスを外すと戻る）", () => {
    const host = mount(<StatusDot state="updated" tip="更新あり · 直した内容はまだ読者に出ていません" />);
    const dot = host.querySelector<HTMLElement>(".es-st")!;
    const tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(dot.tabIndex).toBe(0);
    expect(dot.getAttribute("aria-describedby")).toBe(tip.id);
    expect(host.querySelector(".es-st-wrap")!.getAttribute("aria-live")).toBe("polite");
    act(() => dot.focus());
    expect(document.activeElement).toBe(dot);
    key(dot, "Escape");
    expect(host.querySelector(".es-st-wrap")!.getAttribute("data-dismissed")).toBe("true");
    act(() => dot.blur());
    expect(host.querySelector(".es-st-wrap")!.getAttribute("data-dismissed")).toBeNull();
  });

  it("状態が変わると、同じ live 領域の文が替わる（読み上げの対象）", () => {
    const host = mount(<StatusDot state="private" tip="自分だけ · 保存済み" />);
    const region = host.querySelector(".es-st-wrap")!;
    act(() => {
      roots[0]!.render(<StatusDot state="published" tip="公開中 · niho.life/article/x · 保存済み" />);
    });
    expect(host.querySelector(".es-st-wrap")).toBe(region);
    expect(region.querySelector('[role="tooltip"]')!.textContent).toBe("公開中 · niho.life/article/x · 保存済み");
  });
});

describe("道具の帯", () => {
  it("押した操作が onAction へ渡る", () => {
    const onAction = vi.fn();
    const host = mount(<ShellTools onAction={onAction} />);
    for (const label of ["ブロックを足す", "太字", "斜体", "リンク", "見出し", "箇条書き", "画像", "録音"]) {
      act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    }
    expect(onAction.mock.calls.map(([action]) => action)).toEqual(["add-block", "bold", "italic", "link", "heading", "list", "image", "record"]);
  });
});

describe("ShellBubbleMenu（TipTap の bubble-menu）", () => {
  it("BlockEditor と同じ import の BubbleMenu に editor を渡すと、書式の帯のプラグイン（shellFormatBar）が editor に付く", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit], content: "<p>選ぶ文字</p>" });
    const keys = () => editor.state.plugins.map((plugin) => (plugin as unknown as { key: string }).key);
    expect(keys()).not.toContain("shellFormatBar$");
    mount(<ShellBubbleMenu editor={editor} onAi={vi.fn()} />);
    expect(keys()).toContain("shellFormatBar$");
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    expect(keys()).not.toContain("shellFormatBar$");
    editor.destroy();
  });
});
