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
 * ヘッダーの状態の丸（docs-ui の StatusDot）。公開の配線（#39〜#41）がまだ無いので、公開の状態は出さず、いつも「自分だけ」。
 * 言葉は「自分だけ · 保存の状態」（モック v6 の statusDot の「自分だけ · 保存済み」と同じ形）。
 */
export function headerStatus(status: SaveStatus): { state: "private"; tip: string } {
  return { state: "private", tip: `自分だけ · ${SAVE_STATUS_TEXT[status]}` };
}
