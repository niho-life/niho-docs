import { shareDeps } from "@/server/deps";
import { duplicatePageRoute } from "@/server/share-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** ページを複製する。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return duplicatePageRoute(request, id, shareDeps);
}
