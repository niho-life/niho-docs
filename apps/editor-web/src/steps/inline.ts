import { resolveCloudTasksConfig } from "./cloud-tasks";
import { fakeExecutor, type StepExecutor } from "./executor";
import { MemoryTaskQueue, type TaskQueue } from "./queue";
import { runAttempt, type RunnerDeps } from "./runner";

/**
 * 手順を実行する方式。`inline`（同じプロセスで偽物の実行器を回す。開発・CI 用）と、
 * `cloud-tasks`（Cloud Tasks に積み、同じサービスの OIDC で守った worker の route が実行する。docs/architecture/editor-steps-execution.md §5.2）。
 */
export type StepsMode = "inline" | "cloud-tasks";

/**
 * `EDITOR_STEPS_MODE` から方式を決める。未設定・`off`・未知の値は null（run の作成は 503）。
 * 本番（`NODE_ENV=production`）では inline を受け付けない（偽物の結果を本番のページに書かない）。
 * `cloud-tasks` は、キュー・worker の URL・OIDC のサービスアカウントの 3 つが揃い形が正しいときだけ（cloud-tasks.ts）。
 */
export function resolveStepsMode(env: Readonly<Record<string, string | undefined>>): StepsMode | null {
  switch (env.EDITOR_STEPS_MODE) {
    case "inline":
      return env.NODE_ENV === "production" ? null : "inline";
    case "cloud-tasks":
      return resolveCloudTasksConfig(env) ? "cloud-tasks" : null;
    default:
      return null;
  }
}

export type InlineQueueDeps = Pick<RunnerDeps, "store" | "leaseSeconds" | "retryDelaySeconds"> & {
  executor?: StepExecutor;
  /** 想定外の失敗の知らせ（既定はログに名前だけを書く）。 */
  onError?: (error: unknown) => void;
};

/**
 * inline のキュー。積まれた task を、要求を待たせずに（setImmediate・再試行の間隔は setTimeout）同じプロセスで実行し、
 * 次の段階も同じキューに積んで最後まで進める。重複の除去は MemoryTaskQueue に任せる（名前は process の間だけ覚える）。
 */
export function createInlineQueue(deps: InlineQueueDeps): TaskQueue {
  const memory = new MemoryTaskQueue();
  const onError =
    deps.onError ??
    ((error: unknown) => {
      console.error("editor-web: inline step failed", { name: error instanceof Error ? error.name : "unknown" });
    });
  const queue: TaskQueue = {
    async enqueue(task) {
      const result = await memory.enqueue(task);
      if (!result.deduplicated) setImmediate(pump);
      return result;
    },
  };
  const runnerDeps: RunnerDeps = { ...deps, executor: deps.executor ?? fakeExecutor, queue };
  function pump() {
    for (const task of memory.drain()) {
      const start = () => {
        runAttempt(runnerDeps, task).catch(onError);
      };
      if (task.delaySeconds) setTimeout(start, task.delaySeconds * 1000).unref?.();
      else start();
    }
  }
  return queue;
}
