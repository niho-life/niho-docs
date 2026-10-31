import { publishDeps } from "@/server/deps";
import { getPublishSheetRoute, publishRoute } from "@/server/publish-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 公開のシートのデータ（状態・発信先・公開の前に・URL・主ボタン）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getPublishSheetRoute(request, id, publishDeps);
}

/** 公開する・更新を公開・保存・発信先を変える。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return publishRoute(request, id, publishDeps);
}
