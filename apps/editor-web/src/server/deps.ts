import "server-only";
import { getAuthProvider } from "../auth";
import { getStore } from "./db";
import type { PagesApiDeps } from "./pages-api";

/** 実行時の依存（方式の選択・DB の接続は要求のたびに遅延して決める）。 */
export const runtimeDeps: PagesApiDeps = {
  auth: () => getAuthProvider(),
  store: () => getStore(),
};
