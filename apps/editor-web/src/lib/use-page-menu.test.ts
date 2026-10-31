import { describe, expect, it } from "vitest";
import { PAGE_MENU_TEXT, googleDocFailureText, pageMenuItems } from "./use-page-menu";
import { PageActionError } from "./page-actions-client";
import { googleDocsConnectPath, GOOGLE_DOCS_CONNECT_PATH } from "./google-docs-paths";

/** 「…」の項目と、Google ドキュメントの失敗の文言（code ごと）。 */

describe("「…」の項目", () => {
  it("書き出しは .md と Google ドキュメントの 2 つに分かれる", () => {
    const items = pageMenuItems(null);
    expect(items.map((item) => item.id)).toEqual(["share", "export", "export-google-doc", "history", "duplicate", "delete"]);
    const [, markdown, google] = items;
    expect(markdown).toMatchObject({ label: "書き出し", hint: ".md" });
    expect(google).toMatchObject({ label: "Google ドキュメントへ" });
    expect(google!.hint).toBeUndefined();
    // Google の項目も同じ見た目の印を使う（並びの中で浮かない）
    expect(google!.icon).toBe(markdown!.icon);
  });

  it("共有中が分かっているときだけ補足を出す", () => {
    const hintOf = (shared: boolean | null) => pageMenuItems(shared).find((item) => item.id === "share")?.hint;
    expect(hintOf(true)).toBe("共有中");
    expect(hintOf(false)).toBeUndefined();
    expect(hintOf(null)).toBeUndefined();
  });
});

describe("Google ドキュメントの失敗の文言", () => {
  const text = (status: number, code: string | null = null) => googleDocFailureText(new PageActionError(status, code));

  it("code ごとに言い分ける", () => {
    expect(text(401)).toBe(PAGE_MENU_TEXT.signedOut);
    expect(text(503, "google_docs_unavailable")).toBe(PAGE_MENU_TEXT.googleDocUnavailable);
    expect(text(503, "app_not_allowed")).toBe(PAGE_MENU_TEXT.googleDocUnavailable);
    expect(text(502, "export_result_unknown")).toBe(PAGE_MENU_TEXT.googleDocUnknown);
    expect(text(409, "drive_connection_changed")).toBe(PAGE_MENU_TEXT.googleDocRestart);
    expect(text(409, "export_payload_conflict")).toBe(PAGE_MENU_TEXT.googleDocRestart);
    expect(text(502, "google_docs_failed")).toBe(PAGE_MENU_TEXT.googleDocFailed);
    expect(text(500)).toBe(PAGE_MENU_TEXT.googleDocFailed);
    expect(googleDocFailureText(new Error("boom"))).toBe(PAGE_MENU_TEXT.googleDocFailed);
  });

  it("文言に内部の情報を混ぜない", () => {
    for (const message of Object.values(PAGE_MENU_TEXT)) {
      if (typeof message !== "string") continue;
      expect(message).not.toMatch(/https?:|token|Bearer/i);
    }
  });
});

describe("接続の案内の path", () => {
  it("戻り先を付ける（無ければ付けない）", () => {
    expect(googleDocsConnectPath(null)).toBe(GOOGLE_DOCS_CONNECT_PATH);
    expect(googleDocsConnectPath("/p/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11")).toBe(
      `${GOOGLE_DOCS_CONNECT_PATH}?next=%2Fp%2F6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11`,
    );
    // query も含めて 1 つの値として逃がす
    expect(googleDocsConnectPath("/p/new?from=recording")).toBe(`${GOOGLE_DOCS_CONNECT_PATH}?next=%2Fp%2Fnew%3Ffrom%3Drecording`);
  });
});
