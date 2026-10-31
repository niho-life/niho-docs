import { movePage } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** ページをフォルダへ入れる・フォルダから出す（`{ parent: id | null }`）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return movePage(request, id, runtimeDeps);
}
