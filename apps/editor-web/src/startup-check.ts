import { resolveAuthMode } from "./auth/config";
import { FACE_CREDENTIALS_ENV, parseFaceCredentials } from "./public-api/source";
import { parseRateLimit, RATE_LIMIT_ENV } from "./public-api/rate-limit";

/** 起動時の設定の検査（Node のサーバーでだけ読む。src/instrumentation.ts）。誤りなら値を出さずに終了する。 */
export function checkStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  try {
    resolveAuthMode(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid auth configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // 公開 API（#40）の設定は起動を止めない（不正なら面の資格は誰も通さず、rate limit は既定）。値は出さずに不正とだけ書く
  if (parseFaceCredentials(env[FACE_CREDENTIALS_ENV]) === "invalid") {
    console.error(`editor-web: ${FACE_CREDENTIALS_ENV} is invalid; NIHO faces cannot read the public API`);
  }
  if (parseRateLimit(env[RATE_LIMIT_ENV]) === "invalid") {
    console.error(`editor-web: ${RATE_LIMIT_ENV} is invalid; using the default`);
  }
}
