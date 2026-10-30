import { resolveAuthMode } from "./auth/config";

/** 起動時の設定の検査（Node のサーバーでだけ読む。src/instrumentation.ts）。誤りなら値を出さずに終了する。 */
export function checkStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  try {
    resolveAuthMode(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid auth configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
}
