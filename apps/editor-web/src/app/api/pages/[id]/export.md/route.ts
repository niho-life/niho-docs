import { shareDeps } from "@/server/deps";
import { exportMarkdownRoute } from "@/server/share-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 本文を Markdown（niho-experience のサブセット）で書き出す。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return exportMarkdownRoute(request, id, shareDeps);
}
