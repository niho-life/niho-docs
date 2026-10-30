import { getAiUsageSummary } from "@/server/ai-api";
import { aiDeps } from "@/server/ai-deps";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return getAiUsageSummary(request, aiDeps);
}
