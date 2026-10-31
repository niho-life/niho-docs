import { resolveAuthMode } from "./auth/config";
import { resolveStorageConfig } from "./storage/config";

/** 起動時の設定の検査（Node のサーバーでだけ読む。src/instrumentation.ts）。誤りなら値を出さずに終了する。 */
export function checkStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  try {
    resolveAuthMode(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid auth configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // 資産の保存先（#36 段 2a）: 本番の fake・gcs で bucket 名が無い／不正・未知の値は起動しない（メッセージに値を出さない）
  try {
    resolveStorageConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid storage configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
}
