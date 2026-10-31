import { previewTokenDeps } from "@/server/deps";
import { issuePreviewTokenRoute } from "@/server/preview-token-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 本人がプレビュー token を発行する（15 分。公開 API の `/v1/preview/{token}.json` で読む）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return issuePreviewTokenRoute(request, id, previewTokenDeps);
}
