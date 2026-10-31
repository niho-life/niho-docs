import { stepsWorkerDeps } from "@/server/steps-deps";
import { sweepStepTasks } from "@/server/steps-worker-api";

export const dynamic = "force-dynamic";

// Cloud Scheduler だけが呼ぶ（Google の OIDC トークンを route の中で検証する。src/server/steps-worker-api.ts）
export async function POST(request: Request): Promise<Response> {
  return sweepStepTasks(request, stepsWorkerDeps);
}
