import { publishDeps } from "@/server/deps";
import { stopPublishingRoute } from "@/server/publish-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 公開をやめる（冪等）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return stopPublishingRoute(request, id, publishDeps);
}
