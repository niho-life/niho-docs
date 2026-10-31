import { createPublicApi, newRequestId, systemClock, type PublicApiClock } from "./handler";
import type { RateLimiter } from "./rate-limit";
import type { FaceCredentialSource, PublicApiSource } from "./source";

/** `/v1/*` の route が使うもの（テストでは差し替える）。 */
export type PublicApiRouteDeps = {
  /** DB が使えないときは null（503 temporarily_unavailable）。 */
  source: () => PublicApiSource | null;
  faces: () => FaceCredentialSource;
  /** instance の中で 1 つ（要求をまたいで数える）。 */
  limiter: () => RateLimiter;
  clock?: PublicApiClock;
};

/**
 * Next の Request を handler に渡し、応答をそのまま Response にする。path と query・header は手を加えずに渡す。
 * requestId は要求ごとに作る（要求の header の値は使わない）。URL・header はログに書かない。
 */
export async function servePublicApi(request: Request, deps: PublicApiRouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  let source: PublicApiSource | null;
  try {
    source = deps.source();
  } catch {
    source = null;
  }
  const api = createPublicApi({ source, faces: deps.faces(), limiter: deps.limiter(), clock: deps.clock ?? systemClock });
  const response = await api.handle({ method: request.method, url: `${url.pathname}${url.search}`, headers, requestId: newRequestId() });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
