import { googleDocsDeps } from "@/server/deps";
import { exportPageRoute } from "@/server/google-docs-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** このページを Google ドキュメントへ書き出す（本文はサーバーが作る）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return exportPageRoute(request, id, googleDocsDeps);
}
