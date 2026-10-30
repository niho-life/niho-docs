import { listTrash } from "@/server/trash-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return listTrash(request, runtimeDeps);
}
