import { transcriptionDeps } from "@/server/deps";
import { startTranscriptionRoute } from "@/server/transcription-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 文字起こしを始める（「もう一度」も同じ。段落がある録音は replace: true のときだけ）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return startTranscriptionRoute(request, id, transcriptionDeps);
}
