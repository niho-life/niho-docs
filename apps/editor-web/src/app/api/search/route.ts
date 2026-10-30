import { searchDeps } from "@/server/deps";
import { searchPagesRoute } from "@/server/search-api";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return searchPagesRoute(request, searchDeps);
}
