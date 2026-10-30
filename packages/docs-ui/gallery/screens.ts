/** ギャラリーの画面一覧（モック v6 の地図。フェーズ1の枠の画面と、フェーズ2の公開シート・設定系ページ）。 */
export type ScreenDef = {
  id: string;
  label: string;
  url: string;
  /** 初めからレールを開いている画面。 */
  rail?: boolean;
  /** 文字を選んだ状態（書式の帯を文字の上に出す）。 */
  sel?: boolean;
  /** AI の提案を本文の下に出している画面。 */
  proposal?: boolean;
};

export const SCREENS: ScreenDef[] = [
  { id: "login", label: "ログイン", url: "/" },
  { id: "page:j1030", label: "今日の日記", url: "/p/…" },
  { id: "new", label: "新しいページ", url: "/p/new" },
  { id: "newrec", label: "録音から（はじめる）", url: "/p/new?from=recording" },
  { id: "page:memo", label: "思考メモ（AIで整える）", url: "/p/…", rail: true, proposal: true },
  { id: "sel:memo", label: "文字を選んだとき（書式）", url: "/p/…", sel: true },
  { id: "page:rec", label: "録音（文字起こし + 手順）", url: "/p/…", rail: true },
  { id: "page:rec2", label: "録音（まだ手順なし）", url: "/p/…" },
  { id: "page:idea", label: "箇条書きのメモ", url: "/p/…" },
  { id: "page:kita", label: "記事（まだ公開していない）", url: "/p/…" },
  { id: "page:enoden", label: "公開中 · experience（更新あり）", url: "/p/…", rail: true },
  { id: "page:gomi", label: "公開中 · niho.life", url: "/p/…" },
  { id: "page:asaichi", label: "公開中 · 自分のサイト", url: "/p/…" },
  { id: "preview:kita", label: "公開するとこう見える", url: "…" },
  { id: "sheet:publish", label: "公開のシート（記事・まだ公開していない）", url: "/p/… + シート" },
  { id: "sheet:done", label: "公開のシート（公開しました）", url: "/p/… + シート" },
  { id: "dest", label: "発信先", url: "/destinations" },
  { id: "sheet:addDest", label: "発信先を追加（シート）", url: "/destinations + シート" },
  { id: "site", label: "自分のサイト", url: "/destinations/site" },
  { id: "account", label: "役割とつながり", url: "/account" },
  { id: "settings", label: "設定", url: "/settings" },
];

export const findScreen = (id: string): ScreenDef | undefined => SCREENS.find((screen) => screen.id === id);

/** `#/page:memo?rail=1&sidebar=0` を route と強制状態に分ける。 */
export function parseHash(hash: string): { route: string; params: URLSearchParams } {
  const raw = hash.replace(/^#\/?/, "");
  const [route = "", query = ""] = raw.split("?");
  return { route: decodeURIComponent(route), params: new URLSearchParams(query) };
}
