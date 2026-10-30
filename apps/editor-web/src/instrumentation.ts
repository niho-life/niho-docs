/**
 * サーバーの起動時に 1 回だけ走る（`next build` では走らない）。本番で EDITOR_AUTH_MODE が niho でなければ止める。
 *
 * Next は register() の throw ではプロセスを止めず、port を開いたまま全ての要求に 500 を返すので、ここでは
 * process を終了する。port を開く前に止めるのは起動の入口（scripts/server-entry.mjs）の役目で、これはその後ろの守り。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkStartupConfig } = await import("./startup-check");
  checkStartupConfig();
}
