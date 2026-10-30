import { shareDeps } from "@/server/deps";
import { enableShareRoute, getShareRoute, stopShareRoute } from "@/server/share-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 共有の状態。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getShareRoute(request, id, shareDeps);
}

/** 共有を始める（冪等）。 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return enableShareRoute(request, id, shareDeps);
}

/** 共有を止める（冪等）。 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return stopShareRoute(request, id, shareDeps);
}
