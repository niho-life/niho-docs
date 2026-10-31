import { listAiConversations } from "@/server/ai-api";
import { aiDeps } from "@/server/ai-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return listAiConversations(request, id, aiDeps);
}
