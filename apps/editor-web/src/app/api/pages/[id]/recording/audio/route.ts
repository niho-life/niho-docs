import { audioStreamDeps } from "@/server/deps";
import { headAudioRoute, streamAudioRoute } from "@/server/audio-stream-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 録音の音声（本人だけ。保存先から読み出して流す。`Range` は範囲 1 つ）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return streamAudioRoute(request, id, audioStreamDeps);
}

/** GET と同じ status・header で、本文なし。 */
export async function HEAD(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return headAudioRoute(request, id, audioStreamDeps);
}
