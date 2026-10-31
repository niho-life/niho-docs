import { transcriptionWorkerDeps } from "@/server/transcription-deps";
import { runTranscriptionTask } from "@/server/transcription-worker-api";

export const dynamic = "force-dynamic";

// Cloud Tasks だけが呼ぶ（Google の OIDC トークンを route の中で検証する。src/server/transcription-worker-api.ts）
export async function POST(request: Request): Promise<Response> {
  return runTranscriptionTask(request, transcriptionWorkerDeps);
}
