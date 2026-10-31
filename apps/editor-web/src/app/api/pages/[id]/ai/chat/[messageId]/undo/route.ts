import { undoAiChat } from "@/server/chat-api";
import { chatDeps } from "@/server/chat-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; messageId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, messageId } = await context.params;
  return undoAiChat(request, id, messageId, chatDeps);
}
