import { recordDeviceChatTurn } from "@/server/chat-api";
import { chatDeps } from "@/server/chat-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** この Mac の CLI（Mac アプリの bridge）が作った結果を書き戻す口。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return recordDeviceChatTurn(request, id, chatDeps);
}
