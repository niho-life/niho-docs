import { errorResponse, guarded, isSameOriginRequest, jsonResponse, noContentResponse, notFoundResponse } from "./http";
import { sessionOf, type PagesApiDeps } from "./pages-api";

/** GET /api/trash — 自分のゴミ箱（削除の新しい順・最大 500・本文は含めない）。 */
export function listTrash(request: Request, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/trash", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    return jsonResponse(200, { pages: await store.listTrash(session.userId) });
  });
}

/**
 * POST /api/trash/{id}/restore — ゴミ箱の自分のページを戻す（一緒にゴミ箱へ入った子孫も）。
 * ゴミ箱に無い・別の人の・存在しない・不正な id はどれも同じ 404。
 */
export function restoreFromTrash(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("POST /api/trash/[id]/restore", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    return (await store.restoreFromTrash(session.userId, id)) ? noContentResponse() : notFoundResponse();
  });
}
