import path from "node:path";

/** packages/docs-ui の絶対パス。 */
export const PACKAGE_DIR = path.resolve(__dirname, "../..");

/** gallery（検査する画面の持ち主）。 */
export const GALLERY_DIR = path.join(PACKAGE_DIR, "gallery");

/** レポート・実行結果・許容リスト更新の作業ファイル。node_modules 配下なので git に入らない。 */
export const CACHE_DIR = path.join(PACKAGE_DIR, "node_modules/.cache/niho-docs-ui-e2e");

/** `UPDATE_KNOWN=1` のとき、各テストが「いまの違反」を 1 ファイルずつ書き出す場所。 */
export const AXE_ACTUAL_DIR = path.join(CACHE_DIR, "axe-actual");

export const KNOWN_VIOLATIONS_PATH = path.join(PACKAGE_DIR, "e2e/known-violations.json");
export const KNOWN_OVERFLOW_PATH = path.join(PACKAGE_DIR, "e2e/known-overflow.json");
