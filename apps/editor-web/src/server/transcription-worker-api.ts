import { isPageId } from "@niho/editor-store";
import { transcriptionTaskName, type TranscriptionQueue, type TranscriptionTasksConfig } from "../transcription/cloud-tasks";
import type { ExecuteRunOutcome } from "../transcription/run";
import type { OidcVerifyResult } from "./google-oidc";
import { errorResponse, guarded, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 文字起こしの worker の route（#36 段 2b。`/api/internal/transcription/run`・`/api/internal/transcription/sweep`）。
 * Cloud Tasks と Cloud Scheduler だけが呼ぶ。守り方は手順の worker（steps-worker-api.ts）とまったく同じ: サービスは誰でも
 * 呼べる設定なので、Google の ID トークン（OIDC）をここで検証する。順は
 * 方式（cloud-tasks でなければ 404）→ トークン（無い・通らないなら本文を読まずに 401）→ Origin つき（ブラウザ）なら 403 → 実行の準備 → 本文。
 * 応答の本文は短い code・数だけ。ログにもトークン・本文・クレームの値・音声・鍵を出さない。
 */

/** 掃除が読み書きする store（packages/editor-store の関数に Pool を渡したもの）。 */
export type TranscriptionSweepStore = {
  /** 取り残された run を失敗にする（running は engine_timeout、queued は internal）。失敗にした run の id。 */
  failStale: (options: { olderThanSec: number; now: Date }) => Promise<string[]>;
  /** まだ queued の run（積み直す対象。`olderThan` より前に作られたものだけ）。 */
  listQueued: (options: { olderThan: Date; limit: number }) => Promise<{ id: string; generation: number }[]>;
  /** 積み直す前に世代を 1 つ進める（新しい世代。queued でなくなっていれば null）。 */
  requeue: (runId: string, generation: number) => Promise<number | null>;
};

/** 実行の準備（エンジン・保存先・DB・積み直し先が揃ったもの）。 */
export type TranscriptionWorkerRunner = {
  /** run を 1 回実行する（executeRun。例外は外へ出さない）。 */
  execute: (runId: string) => Promise<ExecuteRunOutcome>;
  sweep: TranscriptionSweepStore;
  /** 掃除の積み直し先（開始と同じキュー）。 */
  queue: TranscriptionQueue;
  /** 1 回の文字起こしの時間切れ（秒。`EDITOR_TRANSCRIBE_TIMEOUT_SEC`）。取り残しの判定に使う。 */
  timeoutSec: number;
};

export type TranscriptionWorkerDeps = {
  /** cloud-tasks の設定。方式が cloud-tasks でない・設定が揃わないときは null（404）。 */
  config: () => TranscriptionTasksConfig | null;
  /** ID トークンの検証（route では verifyGoogleOidc）。 */
  verify: (token: string, expected: { audience: string; allowedEmail: string }) => Promise<OidcVerifyResult>;
  /** DB・保存先・エンジンが使えないときは null（503。Cloud Tasks が再試行する）。 */
  runner: () => TranscriptionWorkerRunner | null;
  now?: () => number;
};

const RUN_ROUTE = "POST /api/internal/transcription/run";
const SWEEP_ROUTE = "POST /api/internal/transcription/sweep";
/** run の本文の上限（`{ runId }` だけ）。 */
export const RUN_BODY_LIMIT = 1024;
/** 1 回の掃除で積み直す数の上限（残りは次の回が拾う）。 */
export const SWEEP_LIMIT = 100;
/**
 * 取り残しと見なすまでの、時間切れへの上乗せ（秒）。時間切れそのもので失敗にすると、エンジンの時間切れで run を
 * `engine_timeout` にしようとしている実行を横から奪ってしまう。Cloud Run の要求の上限（時間切れ ＋ 2 分）より後にする。
 */
export const STALE_MARGIN_SECONDS = 300;
/**
 * 積み直しを待つ時間（ミリ秒）。開始の API が積んでいる最中の run を掃除が二重に積まないよう、これより新しい queued は触らない。
 */
export const REQUEUE_GRACE_MS = 60_000;

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._-]{1,8192})$/i;

type Gate = { ok: true } | { ok: false; response: Response };

function refuse(route: string, code: string): Gate {
  // 理由は code だけをログに書き、応答には出さない
  console.warn("editor-web: transcription worker request refused", { route, code });
  return { ok: false, response: errorResponse("unauthorized") };
}

/** 方式・トークン・Origin の検査。ここまでは本文を読まない。 */
async function gate(request: Request, deps: TranscriptionWorkerDeps, route: string): Promise<Gate> {
  const config = deps.config();
  if (!config) return { ok: false, response: notFoundResponse() };
  const header = request.headers.get("authorization");
  const token = header ? BEARER_PATTERN.exec(header)?.[1] : undefined;
  if (!token) return refuse(route, "missing_token");
  const verified = await deps.verify(token, { audience: config.workerUrl, allowedEmail: config.invokerServiceAccount });
  if (!verified.ok) return refuse(route, verified.code);
  // サーバー同士の呼び出しには Origin が無い。付いていればブラウザからの要求なので受けない（CSRF の経路を作らない）
  if (request.headers.get("origin") !== null) return { ok: false, response: errorResponse("forbidden") };
  return { ok: true };
}

/** `{ runId }` だけを受ける（他の key・UUID でない runId は null）。 */
function parseTask(body: unknown): { runId: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "runId")) return null;
  const { runId } = record;
  if (typeof runId !== "string" || !isPageId(runId)) return null;
  return { runId };
}

/**
 * POST /api/internal/transcription/run — Cloud Tasks の task で run を 1 回実行する。
 * 結果（succeeded・failed・skipped）はどれも 200（run の失敗は表に記録されていて、やり直すのは利用者の「もう一度」なので
 * Cloud Tasks には再試行させない。skipped は他が claim 済み・終わっている＝何もしない）。
 * 例外（DB の障害など）は 500 で、Cloud Tasks が同じ task を再試行する（run は queued のままなので claim できる）。
 */
export function runTranscriptionTask(request: Request, deps: TranscriptionWorkerDeps): Promise<Response> {
  return guarded(RUN_ROUTE, async () => {
    const checked = await gate(request, deps, RUN_ROUTE);
    if (!checked.ok) return checked.response;
    const runner = deps.runner();
    if (!runner) return errorResponse("unavailable");
    const body = await readJsonBody(request, RUN_BODY_LIMIT);
    if (!body.ok) return body.response;
    const task = parseTask(body.value);
    if (!task) return errorResponse("bad_request");
    const outcome = await runner.execute(task.runId);
    return jsonResponse(200, { status: outcome.status });
  });
}

/**
 * POST /api/internal/transcription/sweep — Cloud Scheduler が 5 分おきに呼ぶ掃除。本文は読まない。
 * (a) 時間切れ ＋ 余裕を過ぎた有効な run を失敗にする（running は `engine_timeout`、queued は `internal`。実行する側が落ちた・
 *     積めなかったまま残ったもの。音声は消さないので「もう一度」ができる）。
 * (b) まだ queued の run（60 秒より前に作られたもの）を積み直す。**積む前に世代を 1 つ進める**（requeue）ので、task の名前は
 *     前の task と必ず別になる。Cloud Tasks は消した task の名前を最大 24 時間使わせないため、同じ名前で積み直すと「まだ積まれて
 *     いる（ALREADY_EXISTS）」と「試行を使い切って消えた」の区別がつかず、取りこぼした run がその間だまって止まる。
 *     世代を進められなかった run（その間に claim された・終わった）は積まない（数えない）。
 * (a) を先にするので、(b) で失敗にした run を積み直すことはない。応答は失敗にした数と新しく積んだ数。
 * 積み込みに失敗したものがあれば、残りを積んだうえで 500（次の回でまた拾う。世代は進んだままなので、次も新しい名前で積める）。
 */
export function sweepTranscriptionRuns(request: Request, deps: TranscriptionWorkerDeps): Promise<Response> {
  return guarded(SWEEP_ROUTE, async () => {
    const checked = await gate(request, deps, SWEEP_ROUTE);
    if (!checked.ok) return checked.response;
    const runner = deps.runner();
    if (!runner) return errorResponse("unavailable");
    // 掃除の 2 つの判定は同じ時計で行う
    const now = deps.now?.() ?? Date.now();
    const failed = await runner.sweep.failStale({ olderThanSec: runner.timeoutSec + STALE_MARGIN_SECONDS, now: new Date(now) });
    const queued = await runner.sweep.listQueued({ olderThan: new Date(now - REQUEUE_GRACE_MS), limit: SWEEP_LIMIT });
    let requeued = 0;
    let unqueued = 0;
    let failure: string | undefined;
    for (const run of queued) {
      try {
        // 世代を進めてから積む（進められなければ、その run はもう queued ではない）
        const generation = await runner.sweep.requeue(run.id, run.generation);
        if (generation === null) continue;
        const result = await runner.queue.enqueue({ name: transcriptionTaskName(run.id, generation), runId: run.id });
        if (!result.deduplicated) requeued += 1;
      } catch (error) {
        unqueued += 1;
        failure ??= typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "unknown";
      }
    }
    if (queued.length === SWEEP_LIMIT) {
      console.warn("editor-web: transcription sweep read only the oldest queued runs", { route: SWEEP_ROUTE, read: queued.length });
    }
    if (unqueued > 0) {
      console.error("editor-web: transcription sweep could not requeue every run", { route: SWEEP_ROUTE, requeued, unqueued, code: failure });
      return errorResponse("internal");
    }
    return jsonResponse(200, { failed: failed.length, requeued });
  });
}
