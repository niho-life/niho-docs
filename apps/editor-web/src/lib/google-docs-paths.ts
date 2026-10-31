/**
 * Google ドキュメントの書き出しの path（画面とサーバーの両方が使う。値は 1 か所に置く）。
 * 設計は docs/architecture/editor-google-docs-export.md。
 */

/** 接続の案内の画面（未接続・つなぎ直しのときに案内する）。 */
export const GOOGLE_DOCS_CONNECT_PATH = "/google-docs/connect";

/** 案内の画面へ戻り先を付けた path（戻り先はサーバー側で safeReturnTo を通す）。 */
export function googleDocsConnectPath(next?: string | null): string {
  return next ? `${GOOGLE_DOCS_CONNECT_PATH}?next=${encodeURIComponent(next)}` : GOOGLE_DOCS_CONNECT_PATH;
}
