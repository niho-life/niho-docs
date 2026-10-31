import { imageDeps } from "@/server/deps";
import { sharedImageRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string; assetId: string }> };

/** 共有リンクのページの画像（ログイン不要。token で絞る）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { token, assetId } = await context.params;
  return sharedImageRoute(request, token, assetId, imageDeps);
}
