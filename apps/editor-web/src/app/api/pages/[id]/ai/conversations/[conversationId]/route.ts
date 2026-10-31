import { getAiConversation } from "@/server/ai-api";
import { aiDeps } from "@/server/ai-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; conversationId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, conversationId } = await context.params;
  return getAiConversation(request, id, conversationId, aiDeps);
}
