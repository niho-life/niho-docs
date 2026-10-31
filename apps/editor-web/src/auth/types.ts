import type { AuthMode } from "./config";

/** 認証済みの本人。userId は NIHO の安定したユーザー ID（stub では合成の値）。token・cookie の値は持たない。 */
export type Session = {
  readonly userId: string;
  readonly mode: AuthMode;
  /** 一覧の下の本人の行に出す名前（NIHO から読む。stub では合成の値）。 */
  readonly profile?: { readonly name: string; readonly email?: string };
};

/** getSession が読むのは要求の header だけ（route handler の Request と、server component の headers() の両方を渡せる）。 */
export type SessionRequest = { readonly headers: Pick<Headers, "get"> };

export interface AuthProvider {
  readonly mode: AuthMode;
  getSession(request: SessionRequest): Promise<Session | null>;
  /** `/auth/login/start`。returnTo は safeReturnTo を通した editor の中の path。 */
  beginLogin(input: { request: Request; returnTo: string }): Promise<Response>;
  /** `/auth/callback`。 */
  completeLogin(request: Request): Promise<Response>;
  /** `/auth/logout`（POST・同じ origin だけ）。 */
  logout(request: Request): Promise<Response>;
  /**
   * NIHO の API（`me/docs-drive/*` など）を**本人として**呼ぶための ID token。サーバーの中だけで使い、
   * ブラウザの JavaScript・storage には渡さない。app-connect の契約（niho-app #19459）が出るまでは null
   * （Google ドキュメントの書き出しは 503 `google_docs_unavailable` のまま）。
   */
  apiToken?(session: Session): Promise<string | null>;
}
