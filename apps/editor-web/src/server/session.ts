import "server-only";
import { headers } from "next/headers";
import { getAuthProvider, type Session } from "../auth";

/** server component から今の本人を読む（要求の header だけを使う）。 */
export async function currentSession(): Promise<Session | null> {
  return getAuthProvider().getSession({ headers: await headers() });
}
