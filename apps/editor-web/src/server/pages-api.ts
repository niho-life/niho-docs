import type { EditorStore } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseCreatePage, parsePagePatch } from "./page-input";

/** `/api/pages` が使うもの。route から渡す（テストでは差し替える）。 */
export type PagesApiDeps = {
  auth: () => AuthProvider;
  store: () => Pick<EditorStore, "createPage" | "listPages" | "getPage" | "savePage"> | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

async function sessionOf(request: Request, deps: PagesApiDeps) {
  return deps.auth().getSession(request);
}

/** GET /api/pages — 自分のページの一覧（更新順）。 */
export function listPages(request: Request, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    return jsonResponse(200, { pages: await store.listPages(session.userId) });
  });
}

/** POST /api/pages — 新しいページ（`{}` で空のページ）。 */
export function createPage(request: Request, deps: PagesApiDeps): Promise<Response> {
  return guarded("POST /api/pages", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseCreatePage(body.value);
    if (!input.ok) return errorResponse("bad_request");
    return jsonResponse(201, { page: await store.createPage(session.userId, input.value) });
  });
}

/** GET /api/pages/{id} — 自分のページ。それ以外は全て同じ 404。 */
export function getPage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.getPage(session.userId, id);
    return page ? jsonResponse(200, { page }) : notFoundResponse();
  });
}

/** PATCH /api/pages/{id} — 題名・本文・言語などの部分更新。 */
export function patchPage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const patch = parsePagePatch(body.value);
    if (!patch.ok) return errorResponse("bad_request");
    const page = await store.savePage(session.userId, id, patch.value);
    return page ? jsonResponse(200, { page }) : notFoundResponse();
  });
}
