import { recordDeviceProposal } from "@/server/ai-api";
import { aiDeps } from "@/server/ai-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** この Mac の CLI（Mac アプリの bridge）が作った提案を受ける口。サーバーはモデルを呼ばない。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return recordDeviceProposal(request, id, aiDeps);
}
