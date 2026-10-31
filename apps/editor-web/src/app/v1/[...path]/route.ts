import { publicApiDeps } from "@/server/deps";
import { servePublicApi } from "@/public-api/http";

/**
 * 公開 API v1（#40。`https://api.editor.niho.life/v1/...`）。一覧・公開版・プレビューの 3 本を src/public-api/handler.ts が答える。
 * GET・HEAD 以外のメソッドも handler に渡し、契約どおり 400 `invalid_request`（`Allow: GET, HEAD`）にする
 * （OPTIONS を書かないと Next が自分で 204 を返す）。header の扱いは next.config.ts の `/v1` の規則を見る。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request): Promise<Response> => servePublicApi(request, publicApiDeps);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
