import { disconnectDestination } from "@/server/connections-api";
import { connectionsDeps } from "@/server/connections-deps";

export const dynamic = "force-dynamic";

/** 接続を解除する（鍵を失効し、公開中のページを「公開をやめた」にする）。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return disconnectDestination(request, id, connectionsDeps);
}
