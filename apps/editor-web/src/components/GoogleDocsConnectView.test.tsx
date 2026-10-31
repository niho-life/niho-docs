import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsConnection } from "@/google-docs/gateway";
import { GoogleDocsConnectView } from "./GoogleDocsConnectView";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/** 接続の案内（`/google-docs/connect`）。JavaScript を使わず form だけで接続・解除できること。 */

const CONNECTED: GoogleDocsConnection = { status: "CONNECTED", connectedEmail: "person@example.test", reason: null };
const DISCONNECTED: GoogleDocsConnection = { status: "DISCONNECTED", connectedEmail: null, reason: null };
const PAGE = "/p/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

const render = (props: Parameters<typeof GoogleDocsConnectView>[0]) => renderToStaticMarkup(<GoogleDocsConnectView {...props} />);

describe("Google ドキュメントの接続の案内", () => {
  it("未接続なら「接続する」の form を出し、戻り先を付ける", () => {
    const html = render({ connection: DISCONNECTED, error: null, returnTo: PAGE });
    expect(html).toContain(`action="/api/google-docs/connect?next=${encodeURIComponent(PAGE)}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain("接続する");
    expect(html).toContain(`href="${PAGE}"`);
    expect(html).not.toContain("接続をやめる");
  });

  it("接続中なら相手のアカウントと「接続をやめる」を出す", () => {
    const html = render({ connection: CONNECTED, error: null, returnTo: PAGE });
    expect(html).toContain("person@example.test");
    expect(html).toContain(`action="/api/google-docs/disconnect?redirect=1&amp;next=${encodeURIComponent(PAGE)}"`);
    expect(html).not.toContain("接続する<");
  });

  it("戻り先が無ければ戻るリンクを出さない", () => {
    const html = render({ connection: DISCONNECTED, error: null, returnTo: "/" });
    expect(html).toContain('action="/api/google-docs/connect"');
    expect(html).not.toContain("ページへ戻る");
  });

  it("使えないときは入口を出さない", () => {
    const html = render({ connection: null, error: "google_docs_unavailable", returnTo: "/" });
    expect(html).toContain("まだ使えません");
    expect(html).not.toContain("<form");
  });

  it("失敗の code を一言にする（知らない code も黙らない）", () => {
    const of = (error: string) => render({ connection: DISCONNECTED, error, returnTo: "/" });
    expect(of("app_not_allowed")).toContain("NIHO 側の許可を待っています");
    expect(of("temporarily_unavailable")).toContain("混み合っています");
    expect(of("drive_reconnect_required")).toContain("つなぎ直してください");
    expect(of("something_new")).toContain("しばらくしてから");
    expect(of("app_not_allowed")).toContain('role="alert"');
  });

  it("code をそのまま画面に出さない（内部の名前を見せない）", () => {
    for (const error of ["google_docs_unavailable", "app_not_allowed", "signed_out", "something_new"]) {
      expect(render({ connection: DISCONNECTED, error, returnTo: "/" })).not.toContain(error);
    }
  });
});
