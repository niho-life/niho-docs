/** 最後に開いたページ（`/` を開いたときにそこへ戻る）。id だけを持つ cookie（JavaScript から書く。秘密の値ではない）。 */
export const LAST_PAGE_COOKIE = "editor_last_page";

export function rememberLastPage(id: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LAST_PAGE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
