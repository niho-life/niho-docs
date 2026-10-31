import { imageDeps } from "@/server/deps";
import { completeImageRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; assetId: string }> };

/** 画像のアップロードの完了（保存先の object の大きさが申告どおりなら ready にする）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, assetId } = await context.params;
  return completeImageRoute(request, id, assetId, imageDeps);
}
