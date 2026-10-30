import { getVersion } from "@/server/versions-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; version: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, version } = await context.params;
  return getVersion(request, id, version, runtimeDeps);
}
