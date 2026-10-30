import type { Session } from "../auth/types";

/** 一覧の下の本人の行。名前が無ければ「NIHO アカウント」、補足はメール（stub では「stub」）。 */
export function frameMe(session: Session): { name: string; caption: string; initial: string } {
  const name = session.profile?.name || "NIHO アカウント";
  const caption = session.profile?.email ?? (session.mode === "stub" ? "stub" : "");
  return { name, caption, initial: Array.from(name)[0] ?? "" };
}

/**
 * 要求の header から狭い画面かを推す（サーバーで描く最初の形だけに使う。ブラウザでは matchMedia に替わる）。
 * Client Hints の `Sec-CH-UA-Mobile: ?1` か、User-Agent の Mobi・Android・iPhone。
 */
export function guessNarrow(headers: Pick<Headers, "get">): boolean {
  if (headers.get("sec-ch-ua-mobile") === "?1") return true;
  return /Mobi|Android|iPhone/.test(headers.get("user-agent") ?? "");
}
