import { createDestination, listDestinations } from "@/server/connections-api";
import { connectionsDeps } from "@/server/connections-deps";

export const dynamic = "force-dynamic";

/** 発信先の一覧（役割で出せる面と、本人のサイトの接続）。 */
export function GET(request: Request): Promise<Response> {
  return listDestinations(request, connectionsDeps);
}

/** 本人のサイトを接続する（最初の鍵の平文は、この応答にだけ入る）。 */
export function POST(request: Request): Promise<Response> {
  return createDestination(request, connectionsDeps);
}
