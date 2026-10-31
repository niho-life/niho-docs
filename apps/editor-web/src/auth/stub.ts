import { seeOther } from "./return-to";
import type { AuthProvider, Session } from "./types";

/** stub の固定ユーザー（合成の値。実在の人ではない）。 */
export const STUB_USER_ID = "stub-user";

const STUB_SESSION: Session = Object.freeze({ userId: STUB_USER_ID, mode: "stub", profile: Object.freeze({ name: "開発ユーザー" }) });

/**
 * 開発と CI だけの認証。cookie も token も作らず、どの要求にも同じ合成ユーザーを返す。
 * いつもログイン済みなので、ログインの開始は戻り先へ、callback は `/` へそのまま戻す。
 * 本番（NODE_ENV=production）では resolveAuthMode が stub を拒むので、ここには来ない。
 */
export const stubAuthProvider: AuthProvider = {
  mode: "stub",
  async getSession() {
    return STUB_SESSION;
  },
  async beginLogin({ returnTo }) {
    return seeOther(returnTo);
  },
  async completeLogin() {
    return seeOther("/");
  },
  async logout() {
    return seeOther("/auth/login");
  },
  /** stub の本人は NIHO に実在しないので、NIHO の API は呼べない（Google ドキュメントの書き出しは 503）。 */
  async apiToken() {
    return null;
  },
};
