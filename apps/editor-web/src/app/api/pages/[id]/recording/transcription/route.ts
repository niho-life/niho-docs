import { transcriptionDeps } from "@/server/deps";
import { getTranscriptionRoute } from "@/server/transcription-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 文字起こしの最新の run（キュー・実行中・失敗・完了と、失敗の理由）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getTranscriptionRoute(request, id, transcriptionDeps);
}
