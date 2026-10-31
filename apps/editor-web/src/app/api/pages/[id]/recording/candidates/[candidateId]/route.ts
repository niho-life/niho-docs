import { candidatesDeps } from "@/server/deps";
import { getCandidateRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; candidateId: string }> };

/** 文字起こしの案 1 つ（本文つき。見比べる画面が読む）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return getCandidateRoute(request, id, candidateId, candidatesDeps);
}
