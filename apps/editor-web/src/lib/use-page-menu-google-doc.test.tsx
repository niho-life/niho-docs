// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedPage } from "./attached-page";
import { usePageMenu, type PageMenu } from "./use-page-menu";

/**
 * 「…」の Google ドキュメントへの書き出しで、結果が分からない書き出しの受付 id を持ち続けること
 * （設計 §2: 時間切れでも実はできていた文書を、新しい id で送って二重に作らない）。fetch は偽物。
 */

const PAGE = "11111111-1111-4111-8111-111111111111";
const DOC_URL = "https://docs.google.com/document/d/doc-1/edit";
const completed = { status: "completed", documentId: "doc-1", url: DOC_URL };

type Call = { method: string; path: string; exportId: string };

describe("Google ドキュメントへの書き出しの受付 id", () => {
  let root: Root;
  let container: HTMLElement;
  let menu: PageMenu;
  let calls: Call[];
  let answers: Array<{ status: number; body: unknown }>;
  const openDocument = vi.fn();
  const goToGoogleDocsConnect = vi.fn();

  const page = { id: PAGE, flush: async () => true, shared: null } as unknown as AttachedPage;

  function Harness() {
    menu = usePageMenu({
      page,
      current: () => page,
      onDuplicated: vi.fn(),
      onDeleted: vi.fn(),
      openSheet: vi.fn(),
      focusMore: vi.fn(),
      openDocument,
      goToGoogleDocsConnect,
    });
    return null;
  }

  async function exportOnce() {
    await act(async () => {
      menu.more!.onSelect("export-google-doc");
      // flush → fetch → 状態の確認 → fetch の順に進むので、何度かタスクを回す
      for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    answers = [];
    openDocument.mockReset();
    goToGoogleDocsConnect.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { exportId?: string }) : {};
        const exportId = method === "POST" ? (body.exportId ?? "") : decodeURIComponent(input.split("/").at(-1) ?? "");
        calls.push({ method, path: input, exportId });
        const answer = answers.shift();
        if (!answer) throw new Error(`unexpected request: ${method} ${input}`);
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("結果が分からなかったあとは、同じ id の状態を先に確かめ、できていればそれを開く（もう 1 つ作らない）", async () => {
    answers.push({ status: 504, body: { error: "export_result_unknown" } });
    await exportOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST" });
    const firstId = calls[0]!.exportId;

    answers.push({ status: 200, body: completed });
    await exportOnce();
    // 2 回目は POST せず、同じ id の状態を聞く
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "GET", exportId: firstId });
    expect(openDocument).toHaveBeenCalledWith(DOC_URL);
  });

  it("状態を聞いて受付が無ければ、同じ id で送り直す", async () => {
    answers.push({ status: 504, body: { error: "export_result_unknown" } });
    await exportOnce();
    const firstId = calls[0]!.exportId;

    answers.push({ status: 404, body: { error: "export_not_found" } }, { status: 200, body: completed });
    await exportOnce();
    expect(calls.map((call) => [call.method, call.exportId])).toEqual([
      ["POST", firstId],
      ["GET", firstId],
      ["POST", firstId],
    ]);
    expect(openDocument).toHaveBeenCalledWith(DOC_URL);
  });

  it("まだできていない（受け付けただけ）の間は id を残し、次は送り直さずに状態を聞く", async () => {
    answers.push({ status: 202, body: { status: "pending", retryable: false } });
    await exportOnce();
    const firstId = calls[0]!.exportId;
    expect(openDocument).not.toHaveBeenCalled();

    // 状態を聞いても、まだ。送り直さない
    answers.push({ status: 200, body: { status: "pending", retryable: false } });
    await exportOnce();
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(openDocument).not.toHaveBeenCalled();

    // できていれば開く。そのあとは id を手放す
    answers.push({ status: 200, body: completed });
    await exportOnce();
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
    expect(openDocument).toHaveBeenCalledTimes(1);

    answers.push({ status: 200, body: completed });
    await exportOnce();
    const next = calls.at(-1)!;
    expect(next.method).toBe("POST");
    expect(next.exportId).not.toBe(firstId);
  });

  it("再試行できる（retryable）と分かったら、同じ id で送り直す", async () => {
    answers.push({ status: 202, body: { status: "pending", retryable: true } });
    await exportOnce();
    const firstId = calls[0]!.exportId;

    answers.push({ status: 200, body: { status: "pending", retryable: true } }, { status: 200, body: completed });
    await exportOnce();
    expect(calls.map((call) => [call.method, call.exportId])).toEqual([
      ["POST", firstId],
      ["GET", firstId],
      ["POST", firstId],
    ]);
    expect(openDocument).toHaveBeenCalledWith(DOC_URL);
  });

  it("できたあとと、始めからやり直す失敗のあとは新しい id を使う", async () => {
    answers.push({ status: 200, body: completed });
    await exportOnce();
    answers.push({ status: 409, body: { error: "export_conflict" } });
    await exportOnce();
    answers.push({ status: 200, body: completed });
    await exportOnce();
    const ids = calls.map((call) => call.exportId);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("状態を確かめられなかったときは送らず、id を残す", async () => {
    answers.push({ status: 504, body: { error: "export_result_unknown" } });
    await exportOnce();
    const firstId = calls[0]!.exportId;

    answers.push({ status: 503, body: { error: "unavailable" } });
    await exportOnce();
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);

    answers.push({ status: 200, body: completed });
    await exportOnce();
    expect(calls.at(-1)).toMatchObject({ method: "GET", exportId: firstId });
    expect(openDocument).toHaveBeenCalledWith(DOC_URL);
  });
});
