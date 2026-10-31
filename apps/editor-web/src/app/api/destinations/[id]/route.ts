import { readDestination, updateDestination } from "@/server/connections-api";
import { connectionsDeps } from "@/server/connections-deps";

export const dynamic = "force-dynamic";

/** 接続の設定と、この発信先に公開したページ。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return readDestination(request, id, connectionsDeps);
}

/** サイトの URL・URL の形・受け取り方を変える（handle は変えられない）。 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return updateDestination(request, id, connectionsDeps);
}
