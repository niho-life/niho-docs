import type { ShellStatusState } from "niho-docs-ui/shell";

/** ページの保存の状態と、その言葉（本文の上の表示と、ヘッダーの状態の丸の吹き出しで同じ言葉を使う）。 */

/** 保存の状態（`conflict` は競合の帯が出ていて、自動保存を止めている）。 */
export type SaveStatus = "saved" | "saving" | "offline" | "error" | "conflict" | "signedOut";

export const SAVE_STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "保存済み",
  saving: "保存中",
  offline: "オフライン・この端末に保持",
  error: "保存に失敗しました。もう一度試します",
  conflict: "保存を止めています",
  signedOut: "ログインが切れました。本文はこの端末に残しています",
};

/**
 * ヘッダーの状態の丸（docs-ui の StatusDot）。公開の状態（#39。公開のシートが読んだもの）と保存の状態を 1 つの吹き出しに出す。
 * 公開の状態がまだ分からない・公開していないときは「自分だけ · 保存の状態」（モック v6 の statusDot と同じ形）。
 * 公開しているときは docs-ui の shellStatus の言葉（末尾の「保存済み」は固定の文言なので、いまの保存の状態に替える）。
 */
export function headerStatus(status: SaveStatus, publication?: { state: ShellStatusState; tip: string }): { state: ShellStatusState; tip: string } {
  const saved = SAVE_STATUS_TEXT[status];
  if (!publication || publication.state === "private") return { state: "private", tip: `自分だけ · ${saved}` };
  const published = publication.tip.endsWith(` · ${SAVE_STATUS_TEXT.saved}`) ? publication.tip.slice(0, -` · ${SAVE_STATUS_TEXT.saved}`.length) : publication.tip;
  return { state: publication.state, tip: `${published} · ${saved}` };
}
