import { restoreVersion } from "@/server/versions-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; version: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, version } = await context.params;
  return restoreVersion(request, id, version, runtimeDeps);
}
