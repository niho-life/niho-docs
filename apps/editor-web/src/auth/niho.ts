import type { AuthProvider } from "./types";

/**
 * NIHO アカウントでの認証（EDITOR_AUTH_MODE=niho）。この 1 ファイルだけを差し替える。
 *
 * niho-app #19459（app-connect の契約）が出るまでは fail-closed:
 * - getSession はいつも null（＝未認証。API は 401）。
 * - ログインの開始は未実装のエラー。`/auth/login`・`/auth/callback` の画面は #32。
 *
 * 契約が出たときに守ること（#47）:
 * - PKCE → `/auth/callback` → サーバー側の HttpOnly cookie。NIHO の認証 cookie は共有しない。
 * - token はサーバーだけが持ち、ブラウザの JavaScript・storage に渡さない。
 * - 役割は毎 request で NIHO から読み、editor に保存しない。
 */
export const nihoAuthProvider: AuthProvider = {
  mode: "niho",
  async getSession() {
    return null;
  },
};

export class NihoLoginNotImplementedError extends Error {
  override readonly name = "NihoLoginNotImplementedError";
  constructor() {
    super("NIHO login is not implemented until the niho-app #19459 contract is available");
  }
}

/** NIHO へのログインを始める（#19459 待ち）。 */
export function beginNihoLogin(): never {
  throw new NihoLoginNotImplementedError();
}
