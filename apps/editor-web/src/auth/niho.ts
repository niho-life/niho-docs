import { loginPath, seeOther } from "./return-to";
import type { AuthProvider } from "./types";

/**
 * NIHO アカウントでの認証（EDITOR_AUTH_MODE=niho）。この 1 ファイルだけを差し替える。
 *
 * niho-app #19459（app-connect の契約）が出るまでは fail-closed:
 * - getSession はいつも null（＝未認証。API は 401、画面は `/auth/login` へ）。
 * - ログインの開始と callback は `/auth/login?error=unavailable` へ戻す（開始では戻り先の `next` を残す）。
 *
 * 契約が出たときに守ること（#47・#32）:
 * - beginLogin: PKCE の state と verifier を、戻り先（returnTo）と一緒に短い期限の HttpOnly cookie に入れてから NIHO へ送る。
 * - completeLogin: state を照合し、cookie の戻り先を safeReturnTo でもう一度確かめてから、そこへ 303。
 * - セッションはサーバー側の HttpOnly cookie。NIHO の認証 cookie は共有しない。
 * - token はサーバーだけが持ち、ブラウザの JavaScript・storage に渡さない。
 * - 役割は毎 request で NIHO から読み、editor に保存しない。
 * - logout: サーバー側のセッションと cookie を消して `/auth/login` へ 303。
 */
export const nihoAuthProvider: AuthProvider = {
  mode: "niho",
  async getSession() {
    return null;
  },
  async beginLogin({ returnTo }) {
    return seeOther(loginPath(returnTo, "unavailable"));
  },
  async completeLogin() {
    return seeOther(loginPath("/", "unavailable"));
  },
  async logout() {
    return seeOther("/auth/login");
  },
};
