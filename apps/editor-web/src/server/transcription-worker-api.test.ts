import { describe, expect, it, vi } from "vitest";
import type { TranscriptionQueue, TranscriptionTasksConfig } from "../transcription/cloud-tasks";
import type { ExecuteRunOutcome } from "../transcription/run";
import type { OidcVerifyResult } from "./google-oidc";
import {
  REQUEUE_GRACE_MS,
  RUN_BODY_LIMIT,
  STALE_MARGIN_SECONDS,
  SWEEP_LIMIT,
  runTranscriptionTask,
  sweepTranscriptionRuns,
  type TranscriptionSweepStore,
  type TranscriptionWorkerDeps,
  type TranscriptionWorkerRunner,
} from "./transcription-worker-api";

// 合成の値だけ（本物のプロジェクト・URL・メール・トークンを入れない）
const CONFIG: TranscriptionTasksConfig = {
  queue: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-transcribe",
  workerUrl: "https://worker.example.test",
  invokerServiceAccount: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const RUN_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const OTHER_RUN_ID = "7a2e1e8d-7a7d-4d4a-8b63-7b2e4c2d1e22";
const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);
const TIMEOUT_SEC = 1200;

/** 偽の検証器のトークン: 中身は `{ aud, email }` の JSON（検証器に渡る期待値と比べる）。 */
const tokenFor = (aud = CONFIG.workerUrl, email = CONFIG.invokerServiceAccount) => Buffer.from(JSON.stringify({ aud, email })).toString("base64url");
const GOOD = tokenFor();

function fakeVerifier() {
  return vi.fn(async (token: string, expected: { audience: string; allowedEmail: string }): Promise<OidcVerifyResult> => {
    try {
      const claims = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { aud?: string; email?: string };
      if (claims.aud !== expected.audience) return { ok: false, code: "bad_audience" };
      if (claims.email !== expected.allowedEmail) return { ok: false, code: "bad_email" };
      return { ok: true };
    } catch {
      return { ok: false, code: "malformed" };
    }
  });
}

type QueuedRun = { id: string; generation: number; createdAt: number };

function setup(
  options: {
    config?: TranscriptionTasksConfig | null;
    runner?: "none";
    outcome?: ExecuteRunOutcome;
    queued?: QueuedRun[];
    stale?: string[];
    enqueue?: () => Promise<{ deduplicated: boolean }>;
    /** 世代を進められない run の id（その間に claim された・終わった）。 */
    lost?: string[];
  } = {},
) {
  const execute = vi.fn(async (): Promise<ExecuteRunOutcome> => options.outcome ?? { status: "succeeded" });
  const failStale = vi.fn<TranscriptionSweepStore["failStale"]>(async () => options.stale ?? []);
  const listQueued = vi.fn(async ({ olderThan, limit }: { olderThan: Date; limit: number }) =>
    (options.queued ?? []).filter((run) => run.createdAt < olderThan.getTime()).slice(0, limit),
  );
  // 本物と同じ約束: queued のままなら世代を 1 つ進めて返し、そうでなければ null
  const requeue = vi.fn<TranscriptionSweepStore["requeue"]>(async (runId, generation) =>
    (options.lost ?? []).includes(runId) ? null : generation + 1,
  );
  const enqueue = vi.fn<TranscriptionQueue["enqueue"]>(options.enqueue ?? (async () => ({ deduplicated: false })));
  const verify = fakeVerifier();
  const runner: TranscriptionWorkerRunner = { execute, sweep: { failStale, listQueued, requeue }, queue: { enqueue }, timeoutSec: TIMEOUT_SEC };
  const deps: TranscriptionWorkerDeps = {
    config: () => (options.config === undefined ? CONFIG : options.config),
    verify,
    runner: () => (options.runner === "none" ? null : runner),
    now: () => NOW,
  };
  return { deps, execute, failStale, listQueued, requeue, enqueue, verify };
}

/** 本文を読まれたかどうかを数える要求（highWaterMark 0 なので、読まれるまで pull されない）。 */
function workerRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  const pulls = { count: 0 };
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls.count += 1;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${CONFIG.workerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, pulls };
}

const runRequest = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${GOOD}` }) =>
  workerRequest("/api/internal/transcription/run", body, headers);
const sweepRequest = (headers: Record<string, string> = { authorization: `Bearer ${GOOD}` }) =>
  workerRequest("/api/internal/transcription/sweep", {}, headers);

const jsonOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("the transcription worker routes", () => {
  it("refuses a caller with no token with 401, without reading the body or touching the run", async () => {
    const { deps, execute } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused: Record<string, string>[] = [{}, { authorization: "Bearer" }, { authorization: `Token ${GOOD}` }, { authorization: "Bearer not a token" }];
    for (const headers of refused) {
      const { request, pulls } = runRequest({ runId: RUN_ID }, headers);
      const response = await runTranscriptionTask(request, deps);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await jsonOf(response)).toEqual({ error: "unauthorized" });
      expect(pulls.count).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    }
    const { request } = sweepRequest({});
    expect((await sweepTranscriptionRuns(request, deps)).status).toBe(401);
    // ログは短い code だけ（トークンもクレームも出さない）
    expect(JSON.stringify(warn.mock.calls)).not.toContain(GOOD);
    expect(warn.mock.calls.at(0)).toEqual(["editor-web: transcription worker request refused", { route: "POST /api/internal/transcription/run", code: "missing_token" }]);
    warn.mockRestore();
  });

  it("refuses a token of another audience or another identity with the same 401", async () => {
    const { deps, execute, failStale } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const token of [tokenFor("https://elsewhere.example.test"), tokenFor(CONFIG.workerUrl, "someone-else@synthetic-project.iam.gserviceaccount.com")]) {
      const run = await runTranscriptionTask(runRequest({ runId: RUN_ID }, { authorization: `Bearer ${token}` }).request, deps);
      expect(run.status).toBe(401);
      expect(await jsonOf(run)).toEqual({ error: "unauthorized" });
      const sweep = await sweepTranscriptionRuns(sweepRequest({ authorization: `Bearer ${token}` }).request, deps);
      expect(sweep.status).toBe(401);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(failStale).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is 404 while the mode is not cloud-tasks (nothing is verified or read)", async () => {
    const { deps, execute, verify } = setup({ config: null });
    const run = await runTranscriptionTask(runRequest({ runId: RUN_ID }).request, deps);
    expect(run.status).toBe(404);
    expect(await jsonOf(run)).toEqual({ error: "not_found" });
    expect((await sweepTranscriptionRuns(sweepRequest().request, deps)).status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a request that carries an Origin (a browser) with 403", async () => {
    const { deps, execute } = setup();
    const headers = { authorization: `Bearer ${GOOD}`, origin: CONFIG.workerUrl };
    const run = await runTranscriptionTask(runRequest({ runId: RUN_ID }, headers).request, deps);
    expect(run.status).toBe(403);
    expect((await sweepTranscriptionRuns(sweepRequest(headers).request, deps)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers 503 when the engine, the storage or the database is not ready, so Cloud Tasks retries", async () => {
    const { deps } = setup({ runner: "none" });
    const run = await runTranscriptionTask(runRequest({ runId: RUN_ID }).request, deps);
    expect(run.status).toBe(503);
    expect(await jsonOf(run)).toEqual({ error: "unavailable" });
    expect((await sweepTranscriptionRuns(sweepRequest().request, deps)).status).toBe(503);
  });

  it("runs the run of the task and answers 200 with the outcome, whatever it is", async () => {
    for (const outcome of [{ status: "succeeded" }, { status: "failed", errorCode: "engine_timeout" }, { status: "skipped" }] as ExecuteRunOutcome[]) {
      const { deps, execute } = setup({ outcome });
      const response = await runTranscriptionTask(runRequest({ runId: RUN_ID }).request, deps);
      expect(response.status).toBe(200);
      expect(await jsonOf(response)).toEqual({ status: outcome.status });
      expect(execute).toHaveBeenCalledWith(RUN_ID);
    }
  });

  it("takes `{ runId }` only, and answers 400 to anything else", async () => {
    const { deps, execute } = setup();
    for (const body of [{}, { runId: "not-a-uuid" }, { runId: RUN_ID, extra: 1 }, { runId: [RUN_ID] }, [RUN_ID], "null", { runid: RUN_ID }]) {
      const response = await runTranscriptionTask(runRequest(body).request, deps);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await jsonOf(response)).toEqual({ error: "bad_request" });
    }
    expect(execute).not.toHaveBeenCalled();
    // 上限を超える本文は読み切らずに 413
    const big = await runTranscriptionTask(runRequest(`{"runId":"${"x".repeat(RUN_BODY_LIMIT)}"}`).request, deps);
    expect(big.status).toBe(413);
  });

  it("sweeps: fails what is stranded past the timeout and requeues what is still queued", async () => {
    const queued = [
      { id: RUN_ID, generation: 0, createdAt: NOW - 10 * 60_000 },
      { id: OTHER_RUN_ID, generation: 0, createdAt: NOW - 5 * 60_000 },
    ];
    const { deps, failStale, listQueued, requeue, enqueue } = setup({ queued, stale: ["3b0f2c5e-9a1e-4a7f-8c2d-5e6f7a8b9c01"] });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ failed: 1, requeued: 2 });
    // 取り残しの判定は、時間切れそのものではなく時間切れ ＋ 余裕（実行中の run を横から奪わない）
    expect(failStale).toHaveBeenCalledWith({ olderThanSec: TIMEOUT_SEC + STALE_MARGIN_SECONDS, now: new Date(NOW) });
    expect(listQueued).toHaveBeenCalledWith({ olderThan: new Date(NOW - REQUEUE_GRACE_MS), limit: SWEEP_LIMIT });
    // 積む前に世代が進むので、名前は前の task と必ず別になる（消えた task の名前は最大 24 時間ふさがる）
    expect(requeue.mock.calls).toEqual([
      [RUN_ID, 0],
      [OTHER_RUN_ID, 0],
    ]);
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([
      { name: `${RUN_ID}-1`, runId: RUN_ID },
      { name: `${OTHER_RUN_ID}-1`, runId: OTHER_RUN_ID },
    ]);
  });

  it("requeues a run whose task used up its attempts, under a name the deleted task does not hold", async () => {
    // 3 回の配信を使い切った task は Cloud Tasks から消えるが、その名前（<run>-0）は最大 24 時間ふさがる。
    // 同じ名前で積み直すと ALREADY_EXISTS が返り、消えた task と生きている task の区別がつかない（run が 24 時間止まる）。
    const queued = [{ id: RUN_ID, generation: 0, createdAt: NOW - 20 * 60_000 }];
    const taken = new Set([`${RUN_ID}-0`]);
    const { deps, requeue, enqueue } = setup({
      queued,
      enqueue: async () => {
        throw new Error("the fake queue is replaced below");
      },
    });
    enqueue.mockImplementation(async (task) => {
      if (taken.has(task.name)) return { deduplicated: true };
      taken.add(task.name);
      return { deduplicated: false };
    });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(response.status).toBe(200);
    // 消えた名前ではなく、世代を進めた新しい名前で積まれる（＝この回で拾い直せている）
    expect(requeue).toHaveBeenCalledWith(RUN_ID, 0);
    expect(enqueue).toHaveBeenCalledWith({ name: `${RUN_ID}-1`, runId: RUN_ID });
    expect(await jsonOf(response)).toEqual({ failed: 0, requeued: 1 });
  });

  it("does not enqueue a run that stopped being queued while the sweep was reading", async () => {
    const queued = [
      { id: RUN_ID, generation: 0, createdAt: NOW - 10 * 60_000 },
      { id: OTHER_RUN_ID, generation: 0, createdAt: NOW - 9 * 60_000 },
    ];
    const { deps, enqueue } = setup({ queued, lost: [RUN_ID] });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(await jsonOf(response)).toEqual({ failed: 0, requeued: 1 });
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([{ name: `${OTHER_RUN_ID}-1`, runId: OTHER_RUN_ID }]);
  });

  it("leaves a run that was just created to the start that is still enqueueing it", async () => {
    const queued = [{ id: RUN_ID, generation: 0, createdAt: NOW - 5_000 }];
    const { deps, enqueue } = setup({ queued });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(await jsonOf(response)).toEqual({ failed: 0, requeued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not count a task that is already queued as requeued", async () => {
    const queued = [{ id: RUN_ID, generation: 1, createdAt: NOW - 10 * 60_000 }];
    const { deps } = setup({ queued, enqueue: async () => ({ deduplicated: true }) });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ failed: 0, requeued: 0 });
  });

  it("enqueues the rest and then answers 500 when a requeue fails, so the next sweep picks it up again", async () => {
    const queued = [
      { id: RUN_ID, generation: 0, createdAt: NOW - 10 * 60_000 },
      { id: OTHER_RUN_ID, generation: 0, createdAt: NOW - 9 * 60_000 },
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let first = true;
    const { deps, enqueue } = setup({
      queued,
      enqueue: async () => {
        if (first) {
          first = false;
          throw Object.assign(new Error("cloud tasks: tasks_http_403"), { code: "tasks_http_403" });
        }
        return { deduplicated: false };
      },
    });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(response.status).toBe(500);
    expect(await jsonOf(response)).toEqual({ error: "internal" });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.at(0)).toEqual([
      "editor-web: transcription sweep could not requeue every run",
      { route: "POST /api/internal/transcription/sweep", requeued: 1, unqueued: 1, code: "tasks_http_403" },
    ]);
    errors.mockRestore();
  });

  it("warns when there are more queued runs than one sweep reads", async () => {
    const queued = Array.from({ length: SWEEP_LIMIT + 5 }, (_, index) => ({
      id: `6f1d0d7c-6f6c-4c39-9a52-${String(index).padStart(12, "0")}`,
      generation: 0,
      createdAt: NOW - 10 * 60_000,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, enqueue } = setup({ queued });
    const response = await sweepTranscriptionRuns(sweepRequest().request, deps);
    expect(await jsonOf(response)).toEqual({ failed: 0, requeued: SWEEP_LIMIT });
    expect(enqueue).toHaveBeenCalledTimes(SWEEP_LIMIT);
    expect(warn.mock.calls.at(0)?.[0]).toBe("editor-web: transcription sweep read only the oldest queued runs");
    warn.mockRestore();
  });
});
