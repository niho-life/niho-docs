import { getSteps } from "@/server/steps-api";
import { stepsDeps } from "@/server/steps-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getSteps(request, id, stepsDeps);
}
