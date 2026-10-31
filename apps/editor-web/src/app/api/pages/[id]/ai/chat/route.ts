import { runAiChat } from "@/server/chat-api";
import { chatDeps } from "@/server/chat-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return runAiChat(request, id, chatDeps);
}
