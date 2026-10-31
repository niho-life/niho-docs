import { audioDeps } from "@/server/deps";
import { audioLimitsRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

/** 録音の音声の上限と受け付ける形式。 */
export function GET(request: Request): Promise<Response> {
  return audioLimitsRoute(request, audioDeps);
}
