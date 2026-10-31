import { imageDeps } from "@/server/deps";
import { readImageRoute, updateImageRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ assetId: string }> };

/** 画像の中身の中継（本人だけ。署名付き URL はブラウザへ渡さない）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { assetId } = await context.params;
  return readImageRoute(request, assetId, imageDeps);
}

/** 画像の alt・クレジット・掲載許諾を直す。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { assetId } = await context.params;
  return updateImageRoute(request, assetId, imageDeps);
}
