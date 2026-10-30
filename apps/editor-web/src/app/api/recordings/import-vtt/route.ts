import { recordingDeps } from "@/server/deps";
import { importVttRoute } from "@/server/recordings-api";

export const dynamic = "force-dynamic";

/** VTT を取り込んで録音ページを作る。 */
export function POST(request: Request): Promise<Response> {
  return importVttRoute(request, recordingDeps);
}
