import { isIdempotencyKey, type AttemptState, type RunState, type StepRunView, type StepStatus } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { resolveStepsMode } from "../steps/inline";
import { taskName, type TaskQueue } from "../steps/queue";
import { findRecipeIn, isRecipeKey, type RecipeDef, type RecipeReader } from "../steps/recipes";
import type { StepRunStore } from "../steps/store";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/** `/api/pages/{id}/steps/**` が使うもの。route から渡す（テストでは差し替える）。 */
export type StepsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  steps: () => StepRunStore | null;
  /** その人の手順（設定で変えたものを既定にかぶせたもの。#108）。DB が使えないときは null（503）。 */
  recipes: () => RecipeReader | null;
  /** 実行の方式（`EDITOR_STEPS_MODE`）に応じたキュー。使えないときは null（run の作成は 503 `steps_unavailable`）。 */
  queue: () => TaskQueue | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 帯に出す run（段階の名前は手順の定義から）。 */
export type RunView = {
  id: string;
  recipe: string;
  state: RunState;
  fromStep: number;
  steps: {
    index: number;
    id: string;
    name: string;
    state: AttemptState;
    pageId: string;
    stepStatus: StepStatus | null;
    tries: number;
    errorCode: string | null;
  }[];
};

/** http.ts の code に無いもの（http.ts は変えず、共通の header はそのまま使う）。 */
type StepsErrorCode = "steps_unavailable" | "run_in_progress" | "invalid_from_step";
const STEPS_ERROR_STATUS: Record<StepsErrorCode, number> = { steps_unavailable: 503, run_in_progress: 409, invalid_from_step: 400 };

function stepsError(code: StepsErrorCode): Response {
  return jsonResponse(STEPS_ERROR_STATUS[code], { error: code });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * pages-api.ts の guarded と同じ（他の PR と並行して触らないよう、ここに置いている）。
 */
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

function toRunView(run: StepRunView, recipes: readonly RecipeDef[]): RunView {
  const recipe = findRecipeIn(recipes, run.recipe);
  return {
    id: run.id,
    recipe: run.recipe,
    state: run.state,
    fromStep: run.fromStep,
    steps: run.steps.map((step) => ({
      index: step.index,
      id: step.stepId,
      name: recipe?.steps[step.index]?.name ?? "",
      state: step.state,
      pageId: step.pageId,
      stepStatus: step.stepStatus,
      tries: step.tries,
      errorCode: step.errorCode,
    })),
  };
}

type RunInput = { ok: true; recipe: RecipeDef; fromStep: number } | { ok: false };

/** `{ recipe, fromStep? }` だけを受ける（他の key・知らない手順・範囲外の段階は 400）。 */
function parseRunInput(body: unknown, recipes: readonly RecipeDef[]): RunInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "recipe" || key === "fromStep")) return { ok: false };
  if (!isRecipeKey(record.recipe)) return { ok: false };
  const recipe = findRecipeIn(recipes, record.recipe);
  if (!recipe) return { ok: false };
  const fromStep = record.fromStep ?? 0;
  if (typeof fromStep !== "number" || !Number.isInteger(fromStep) || fromStep < 0 || fromStep >= recipe.steps.length) return { ok: false };
  return { ok: true, recipe, fromStep };
}

/** GET /api/pages/{id}/steps — そのページの最新の run（無ければ null）。返す前に前提変更を再計算する。 */
export function getSteps(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/steps", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const listed = await steps.listRun(session.userId, id);
    if (!listed) return notFoundResponse();
    let run = listed.run;
    const recipes = await readRecipes(session.userId);
    const recipe = run ? findRecipeIn(recipes, run.recipe) : undefined;
    if (run && recipe && (await steps.refreshStale(session.userId, id, recipe)) > 0) {
      run = (await steps.listRun(session.userId, id))?.run ?? null;
    }
    return jsonResponse(200, { run: run ? toRunView(run, recipes) : null });
  });
}

/** POST /api/pages/{id}/steps/runs — 録音ページで手順を始める（`fromStep` からの作り直しを含む）。 */
export function createStepRun(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/steps/runs", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const recipes = await readRecipes(session.userId);
    const input = parseRunInput(body.value, recipes);
    if (!input.ok) return errorResponse("bad_request");
    const key = request.headers.get("idempotency-key");
    if (key !== null && !isIdempotencyKey(key)) return errorResponse("bad_request");
    if (!resolveStepsMode(deps.env ?? process.env)) return stepsError("steps_unavailable");
    const queue = deps.queue();
    if (!queue) return stepsError("steps_unavailable");

    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const result = await steps.createRun(owner, id, { recipe: input.recipe, fromStep: input.fromStep, idempotencyKey: key });
    switch (result.status) {
      case "not_found":
        return notFoundResponse();
      case "run_in_progress":
      case "invalid_from_step":
        return stepsError(result.status);
      case "existing":
        // 同じ要求の再送。積むのは最初の要求だけ
        return jsonResponse(202, { run: toRunView(result.run, recipes) });
      case "created":
        break;
    }
    const { run } = result;
    try {
      await queue.enqueue({ name: taskName(run.id, run.fromStep, 0), runId: run.id, stepIndex: run.fromStep });
    } catch (error) {
      // 積めなかった run を進行中のまま残さない（同じ録音ページで次の run を作れるように）
      await steps.cancelRun(owner, id, run.id);
      throw error;
    }
    return jsonResponse(202, { run: toRunView(run, recipes) });
  });
}

/** POST /api/pages/{id}/steps/runs/{runId}/cancel — 取消（冪等）。 */
export function cancelStepRun(request: Request, id: string, runId: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/steps/runs/[runId]/cancel", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const run = await steps.cancelRun(session.userId, id, runId);
    return run ? jsonResponse(200, { run: toRunView(run, await readRecipes(session.userId)) }) : notFoundResponse();
  });
}
