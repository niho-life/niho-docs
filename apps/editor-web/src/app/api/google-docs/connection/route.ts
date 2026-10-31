import { googleDocsDeps } from "@/server/deps";
import { connectionRoute } from "@/server/google-docs-api";

export const dynamic = "force-dynamic";

/** 本人の Google ドキュメント接続の状態。 */
export async function GET(request: Request): Promise<Response> {
  return connectionRoute(request, googleDocsDeps);
}
