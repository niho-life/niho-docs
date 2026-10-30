import { deletePage, getPage, patchPage } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getPage(request, id, runtimeDeps);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchPage(request, id, runtimeDeps);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return deletePage(request, id, runtimeDeps);
}
