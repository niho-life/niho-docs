/**
 * 認証の方式（#47）。`EDITOR_AUTH_MODE=stub|niho`。
 *
 * - stub: 固定の合成ユーザー 1 人。開発と CI だけ。
 * - niho: NIHO の app-connect（niho-app #19459 の契約待ち。src/auth/niho.ts）。
 *
 * 本番の守り：NODE_ENV=production で niho 以外（未設定を含む）は stub へ落とさずに throw する。
 * この関数は import しただけでは何もしない。呼ぶのは次の 3 か所で、`next build`（これも NODE_ENV=production）の途中では呼ばない:
 * - scripts/server-entry.mjs: server を読み込む前（port を開く前）。Node がこのファイルを直接読むので、
 *   このファイルは依存を持たず、型を消すだけで動く TypeScript（erasable syntax）だけで書く。
 * - src/instrumentation.ts: `next start`・`next dev` の起動時。
 * - src/auth/index.ts: 要求ごとの方式の選択。
 */

export const AUTH_MODES = ["stub", "niho"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type AuthEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_AUTH_MODE?: string | undefined;
};

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

function isAuthMode(value: string): value is AuthMode {
  return (AUTH_MODES as readonly string[]).includes(value);
}

export function resolveAuthMode(env: AuthEnv): AuthMode {
  const raw = env.EDITOR_AUTH_MODE?.trim() ?? "";
  if (raw !== "" && !isAuthMode(raw)) {
    throw new AuthConfigError("EDITOR_AUTH_MODE must be one of: stub, niho");
  }
  if (env.NODE_ENV === "production" && raw !== "niho") {
    throw new AuthConfigError("EDITOR_AUTH_MODE=niho is required when NODE_ENV=production (stub is for development and CI only)");
  }
  return raw === "" ? "stub" : raw;
}
