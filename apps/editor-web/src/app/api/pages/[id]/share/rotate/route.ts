import { shareDeps } from "@/server/deps";
import { rotateShareRoute } from "@/server/share-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** リンクを作り直す（古いリンクはすぐ見られなくなる）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return rotateShareRoute(request, id, shareDeps);
}
