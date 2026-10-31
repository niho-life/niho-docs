import { googleDocsDeps } from "@/server/deps";
import { exportStatusRoute } from "@/server/google-docs-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ exportId: string }> };

/** 受け付けた書き出しの状態（結果が分からなかったときに確かめる）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { exportId } = await context.params;
  return exportStatusRoute(request, exportId, googleDocsDeps);
}
