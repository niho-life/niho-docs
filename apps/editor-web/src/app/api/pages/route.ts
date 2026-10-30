import { createPage, listPages } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return listPages(request, runtimeDeps);
}

export function POST(request: Request): Promise<Response> {
  return createPage(request, runtimeDeps);
}
