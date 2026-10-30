import type { AuthMode } from "./config";

/** 認証済みの本人。userId は NIHO の安定したユーザー ID（stub では合成の値）。token・cookie の値は持たない。 */
export type Session = {
  readonly userId: string;
  readonly mode: AuthMode;
};

/** getSession が読むのは要求の header だけ（route handler の Request と、server component の headers() の両方を渡せる）。 */
export type SessionRequest = { readonly headers: Pick<Headers, "get"> };

export interface AuthProvider {
  readonly mode: AuthMode;
  getSession(request: SessionRequest): Promise<Session | null>;
}
