import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { fakeExecutor } from "../steps/executor";
import { MemoryStepRunStore } from "../steps/memory-store";
import { MemoryTaskQueue, taskName, type TaskQueue } from "../steps/queue";
import { runAttempt } from "../steps/runner";
import { MAX_BODY_BYTES } from "./http";
import { cancelStepRun, createStepRun, getSteps, type RunView, type StepsApiDeps } from "./steps-api";

const ORIGIN = "http://editor.test";
const INLINE = { EDITOR_STEPS_MODE: "inline" };
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];

/** 手順の API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the steps API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function deps(
  userId: string | null,
  store: MemoryStepRunStore | null,
  options: { env?: Record<string, string | undefined>; queue?: TaskQueue | null } = {},
): StepsApiDeps {
  const queue = options.queue === undefined ? new MemoryTaskQueue() : options.queue;
  return { auth: () => authAs(userId), steps: () => store, queue: () => queue, env: options.env ?? INLINE };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

/** date 以外の header を並べたもの（同じ応答かどうかを比べる）。 */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

function setup() {
  const store = new MemoryStepRunStore();
  const recording = store.addPage("user-a", { kind: "rec", blocks: transcript });
  return { store, recording };
}

const start = (id: string, body: unknown, d: StepsApiDeps, headers?: Record<string, string>) =>
  createStepRun(request("POST", `/api/pages/${id}/steps/runs`, body, headers), id, d);
const read = (id: string, d: StepsApiDeps) => getSteps(request("GET", `/api/pages/${id}/steps`), id, d);
const cancel = (id: string, runId: string, d: StepsApiDeps, headers?: Record<string, string>) =>
  cancelStepRun(request("POST", `/api/pages/${id}/steps/runs/${runId}/cancel`, undefined, headers), id, runId, d);

async function runOf(response: Response): Promise<RunView> {
  return ((await response.json()) as { run: RunView }).run;
}

describe("/api/pages/{id}/steps", () => {
  it("starts a run on a recording page, queues the first step, and answers 202", async () => {
    const { store, recording } = setup();
    const queue = new MemoryTaskQueue();
    const response = await start(recording, { recipe: "tpl-1" }, deps("user-a", store, { queue }));
    expect(response.status).toBe(202);
    const run = await runOf(response);
    expect(run).toMatchObject({ recipe: "tpl-1", state: "queued", fromStep: 0 });
    expect(run.steps.map((step) => [step.index, step.id, step.name, step.state, step.stepStatus, step.tries, step.errorCode])).toEqual([
      [0, "k7m2q9xa", "文字起こし修正", "queued", "wait", 0, null],
      [1, "r4t8wz3c", "記事方針", "pending", "wait", 0, null],
      [2, "h2n6v5pe", "記事本文", "pending", "wait", 0, null],
    ]);
    expect(Object.keys(run).sort()).toEqual(["fromStep", "id", "recipe", "state", "steps"]);
    expect(queue.drain()).toEqual([{ name: taskName(run.id, 0, 0), runId: run.id, stepIndex: 0 }]);
  });

  it("returns the same run for the same Idempotency-Key and queues it once", async () => {
    const { store, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const headers = { "idempotency-key": "synthetic-key_1" };
    const first = await start(recording, { recipe: "tpl-2" }, d, headers);
    const second = await start(recording, { recipe: "tpl-2" }, d, headers);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect((await runOf(second)).id).toBe((await runOf(first)).id);
    expect(queue.size).toBe(1);
    for (const key of ["has space", "k".repeat(129), "a/b", "a.b"]) {
      const response = await start(recording, { recipe: "tpl-2" }, d, { "idempotency-key": key });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
  });

  it("answers 409 while a run is in progress and 400 when fromStep has no completed upstream", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    expect((await start(recording, { recipe: "tpl-1" }, d)).status).toBe(202);
    const busy = await start(recording, { recipe: "tpl-3" }, d);
    expect(busy.status).toBe(409);
    expect(await busy.text()).toBe('{"error":"run_in_progress"}');

    const other = store.addPage("user-a", { kind: "rec" });
    const invalid = await start(other, { recipe: "tpl-1", fromStep: 1 }, d);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe('{"error":"invalid_from_step"}');
  });

  it("recomputes stale steps on every GET and returns the latest run", async () => {
    const { store, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const empty = await read(recording, d);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ run: null });

    const created = await runOf(await start(recording, { recipe: "tpl-1" }, d));
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) await runAttempt({ store, executor: fakeExecutor, queue }, task);
    }
    const refresh = vi.spyOn(store, "refreshStale");
    const done = await runOf(await read(recording, d));
    expect(done.id).toBe(created.id);
    expect(done.state).toBe("succeeded");
    expect(done.steps.map((step) => step.stepStatus)).toEqual(["done", "done", "done"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.slice(0, 2)).toEqual(["user-a", recording]);
    expect(refresh.mock.calls[0]?.[2]).toMatchObject({ id: "tpl-1" });

    // 上流のサブページを直すと、次の GET で下流が前提変更になる
    store.pages.get(done.steps[0]!.pageId)!.blocks = [{ type: "paragraph", content: [{ type: "text", text: "直した結果" }] }];
    const stale = await runOf(await read(recording, d));
    expect(stale.steps.map((step) => step.stepStatus)).toEqual(["done", "stale", "stale"]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels a run idempotently", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, { recipe: "tpl-1" }, d));
    const first = await cancel(recording, run.id, d);
    expect(first.status).toBe(200);
    const canceled = await runOf(first.clone());
    expect(canceled.state).toBe("canceled");
    expect(canceled.steps.map((step) => step.state)).toEqual(["canceled", "canceled", "canceled"]);
    const again = await cancel(recording, run.id, d);
    expect(await snapshot(again)).toEqual(await snapshot(first));
    // 取消のあとは作り直せる
    expect((await start(recording, { recipe: "tpl-1" }, d)).status).toBe(202);
  });

  it("answers the same 404 for another owner's page, an unknown id, a malformed id, a deleted page, and a page that is not a recording", async () => {
    const { store, recording } = setup();
    const theirs = store.addPage("user-b", { kind: "rec" });
    const removed = store.addPage("user-a", { kind: "rec" });
    store.pages.get(removed)!.deleted = true;
    const note = store.addPage("user-a", { kind: "note" });
    const d = deps("user-a", store);
    const theirRun = await runOf(await start(theirs, { recipe: "tpl-1" }, deps("user-b", store)));
    const mine = await runOf(await start(recording, { recipe: "tpl-1" }, d));
    const ids = [theirs, randomUUID(), "not-a-uuid", "../../etc", removed];

    const reference = await snapshot(await read(randomUUID(), d));
    expect(reference.status).toBe(404);
    expect(reference.body).toBe('{"error":"not_found"}');
    const responses = [
      ...(await Promise.all(ids.map((id) => read(id, d)))),
      ...(await Promise.all([...ids, note].map((id) => start(id, { recipe: "tpl-1" }, d)))),
      ...(await Promise.all(ids.map((id) => cancel(id, mine.id, d)))),
      // 本人のページの path でも、別の人の run・存在しない run・不正な run の id・別のページの run は同じ 404
      ...(await Promise.all([theirRun.id, randomUUID(), "not-a-uuid"].map((runId) => cancel(recording, runId, d)))),
      await cancel(note, mine.id, d),
    ];
    for (const response of responses) expect(await snapshot(response)).toEqual(reference);
    expect(store.runs.get(theirRun.id)?.state).toBe("queued");
    expect(store.runs.get(mine.id)?.state).toBe("queued");
  });

  it("answers 401 without a session on every route", async () => {
    const { store, recording } = setup();
    const responses = [
      await read(recording, deps(null, store)),
      await start(recording, { recipe: "tpl-1" }, deps(null, store)),
      await cancel(recording, randomUUID(), deps(null, store)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 403 to writes from another origin or without an Origin", async () => {
    const { store, recording } = setup();
    const run = await runOf(await start(recording, { recipe: "tpl-1" }, deps("user-a", store)));
    const other = store.addPage("user-a", { kind: "rec" });
    for (const origin of ["https://evil.example", "null", ""]) {
      expect((await start(other, { recipe: "tpl-1" }, deps("user-a", store), { origin })).status).toBe(403);
      expect((await cancel(recording, run.id, deps("user-a", store), { origin })).status).toBe(403);
    }
    expect(store.runs.size).toBe(1);
    expect(store.runs.get(run.id)?.state).toBe("queued");
  });

  it("answers 413 above 1 MiB and 400 to bodies that are not JSON or not the right shape, before looking at the id", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    const big = JSON.stringify({ recipe: "tpl-1", padding: "a".repeat(MAX_BODY_BYTES) });
    expect((await start(recording, big, d)).status).toBe(413);

    const bad: Array<[unknown, Record<string, string>?]> = [
      ["{", undefined],
      ["recipe=tpl-1", { "content-type": "application/x-www-form-urlencoded" }],
      [{ recipe: "tpl-1" }, { "content-type": "text/plain" }],
      [{}, undefined],
      [[], undefined],
      [{ recipe: "tpl-4" }, undefined],
      [{ recipe: "TPL-1" }, undefined],
      [{ recipe: "tpl-1", fromStep: 3 }, undefined],
      [{ recipe: "tpl-1", fromStep: -1 }, undefined],
      [{ recipe: "tpl-1", fromStep: 1.5 }, undefined],
      [{ recipe: "tpl-1", fromStep: "0" }, undefined],
      [{ recipe: "tpl-3", fromStep: 1 }, undefined],
      [{ recipe: "tpl-1", owner: "user-b" }, undefined],
    ];
    for (const id of [recording, "not-a-uuid"]) {
      for (const [body, headers] of bad) {
        const response = await start(id, body, d, headers);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.text()).toBe('{"error":"bad_request"}');
      }
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 503 without a database, and refuses to start runs without a steps mode or with inline in production", async () => {
    const { store, recording } = setup();
    const id = randomUUID();
    for (const response of [
      await read(id, deps("user-a", null)),
      await start(id, { recipe: "tpl-1" }, deps("user-a", null)),
      await cancel(id, randomUUID(), deps("user-a", null)),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"unavailable"}');
    }

    const queue = new MemoryTaskQueue();
    for (const env of [{}, { EDITOR_STEPS_MODE: "off" }, { EDITOR_STEPS_MODE: "cloud" }, { EDITOR_STEPS_MODE: "inline", NODE_ENV: "production" }]) {
      const response = await start(recording, { recipe: "tpl-1" }, deps("user-a", store, { env, queue }));
      expect(response.status, JSON.stringify(env)).toBe(503);
      expect(await response.text()).toBe('{"error":"steps_unavailable"}');
    }
    expect((await start(recording, { recipe: "tpl-1" }, deps("user-a", store, { queue: null }))).status).toBe(503);
    expect(store.runs.size).toBe(0);
    expect(queue.size).toBe(0);

    // 一覧と取消は方式が無くても動く
    const run = await runOf(await start(recording, { recipe: "tpl-1" }, deps("user-a", store)));
    expect((await read(recording, deps("user-a", store, { env: {} }))).status).toBe(200);
    expect((await cancel(recording, run.id, deps("user-a", store, { env: {} }))).status).toBe(200);
  });

  it("answers 500 without internal details, and does not leave a run in progress when it cannot be queued", async () => {
    const { store, recording } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken = new MemoryStepRunStore();
      broken.listRun = async () => {
        throw Object.assign(new Error('relation "step_runs" does not exist at SELECT secret_column FROM step_runs'), { code: "42P01" });
      };
      const response = await read(randomUUID(), deps("user-a", broken));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');

      const failing: TaskQueue = {
        enqueue: async () => {
          throw new Error("synthetic queue failure at https://queue.invalid/secret");
        },
      };
      const queued = await start(recording, { recipe: "tpl-1" }, deps("user-a", store, { queue: failing }));
      expect(queued.status).toBe(500);
      expect(await queued.text()).toBe('{"error":"internal"}');
      expect([...store.runs.values()].map((run) => run.state)).toEqual(["canceled"]);
      expect((await start(recording, { recipe: "tpl-1" }, deps("user-a", store))).status).toBe(202);

      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain("SELECT");
      expect(logged).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });

  it("marks every response noindex, nofollow and uncacheable", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, { recipe: "tpl-1" }, d));
    const responses = [
      await read(recording, d),
      await start(recording, { recipe: "tpl-1" }, d),
      await start(recording, "{", d),
      await cancel(recording, run.id, d),
      await cancel(recording, randomUUID(), d),
      await read(recording, deps(null, store)),
      await read(recording, deps("user-a", null)),
      await start(recording, { recipe: "tpl-1" }, deps("user-a", store, { env: {} })),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});
