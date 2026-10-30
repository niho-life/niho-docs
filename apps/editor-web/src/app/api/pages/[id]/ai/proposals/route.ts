import { createAiProposal } from "@/server/ai-api";
import { aiDeps } from "@/server/ai-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return createAiProposal(request, id, aiDeps);
}
