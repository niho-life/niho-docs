import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthProvider, type Session } from "../auth";
import { loginPath, safeReturnTo } from "../auth/return-to";
import { EDITOR_PATH_HEADER } from "../lib/editor-path";

/** server component から今の本人を読む（要求の header だけを使う）。 */
export async function currentSession(): Promise<Session | null> {
  return getAuthProvider().getSession({ headers: await headers() });
}

/**
 * 本人を読み、未ログインなら `/auth/login?next=…` へ redirect する。
 * path を渡さないときは src/proxy.ts が付けた今の path を戻り先にする（どちらも safeReturnTo を通す）。
 */
export async function requireSession(path?: string): Promise<Session> {
  const requestHeaders = await headers();
  const session = await getAuthProvider().getSession({ headers: requestHeaders });
  if (session) return session;
  redirect(loginPath(safeReturnTo(path ?? requestHeaders.get(EDITOR_PATH_HEADER))));
}
