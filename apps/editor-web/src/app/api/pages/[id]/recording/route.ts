import { recordingDeps } from "@/server/deps";
import { getRecordingRoute, patchRecordingRoute } from "@/server/recordings-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 録音（文字起こしの段落と話者の一覧）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getRecordingRoute(request, id, recordingDeps);
}

/** 段落の編集・話者名の変更・話者をまとめる（1 回に 1 つ。baseRevision が古ければ 409 で最新）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchRecordingRoute(request, id, recordingDeps);
}
