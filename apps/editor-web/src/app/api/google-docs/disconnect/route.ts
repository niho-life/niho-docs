import { safeReturnTo } from "@/auth/return-to";
import { googleDocsConnectPath } from "@/lib/google-docs-paths";
import { googleDocsDeps } from "@/server/deps";
import { disconnectRoute } from "@/server/google-docs-api";

export const dynamic = "force-dynamic";

/**
 * 接続をやめる。案内の画面の form から来たとき（`redirect=1`）はその画面へ 303 で戻し、
 * それ以外は JSON（接続の状態）を返す。
 */
export async function POST(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (params.get("redirect") !== "1") return disconnectRoute(request, googleDocsDeps);
  const returnTo = safeReturnTo(params.get("next"));
  return disconnectRoute(request, googleDocsDeps, googleDocsConnectPath(returnTo === "/" ? null : returnTo));
}
