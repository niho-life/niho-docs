import { rotateDestinationKey } from "@/server/connections-api";
import { connectionsDeps } from "@/server/connections-deps";

export const dynamic = "force-dynamic";

/** 鍵を再発行する（旧鍵は同じトランザクションで失効する。平文はこの応答にだけ入る）。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return rotateDestinationKey(request, id, connectionsDeps);
}
