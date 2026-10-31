import { audioDeps } from "@/server/deps";
import { startAudioRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

/** 音声のアップロードを始める（録音ページを作り、保存先へ直接 PUT するための ticket を返す）。 */
export function POST(request: Request): Promise<Response> {
  return startAudioRoute(request, audioDeps);
}
