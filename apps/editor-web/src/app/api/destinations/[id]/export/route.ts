import { exportDestination } from "@/server/connections-api";
import { connectionsDeps } from "@/server/connections-deps";

export const dynamic = "force-dynamic";

/** Markdown ＋写真の zip（解除したあとでも呼べる）。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return exportDestination(request, id, connectionsDeps);
}
