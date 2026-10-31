import { safeReturnTo } from "@/auth/return-to";
import { googleDocsConnectPath } from "@/lib/google-docs-paths";
import { googleDocsDeps } from "@/server/deps";
import { connectRoute } from "@/server/google-docs-api";

export const dynamic = "force-dynamic";

/**
 * Google の同意へ送る（案内の画面の form から）。失敗は案内の画面へ code を付けて戻す
 * （戻り先の `next` は safeReturnTo を通す）。
 */
export async function POST(request: Request): Promise<Response> {
  const next = new URL(request.url).searchParams.get("next");
  const returnTo = safeReturnTo(next);
  return connectRoute(request, googleDocsDeps, googleDocsConnectPath(returnTo === "/" ? null : returnTo));
}
