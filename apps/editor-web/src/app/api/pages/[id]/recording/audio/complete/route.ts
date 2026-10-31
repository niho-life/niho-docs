import { audioDeps } from "@/server/deps";
import { completeAudioRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 音声のアップロードの完了（保存先の object の大きさが申告どおりなら uploaded にする）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return completeAudioRoute(request, id, audioDeps);
}
