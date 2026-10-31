import { imageDeps } from "@/server/deps";
import { startImageRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 本文の画像のアップロードを始める（資産の行を作り、保存先へ直接 PUT するための ticket を返す）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return startImageRoute(request, id, imageDeps);
}
