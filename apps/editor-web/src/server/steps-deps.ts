import "server-only";
import { getAuthProvider } from "../auth";
import { CloudTasksQueue, resolveCloudTasksConfig, type CloudTasksConfig } from "../steps/cloud-tasks";
import { fakeExecutor, type StepExecutor } from "../steps/executor";
import { createInlineQueue, resolveStepsMode } from "../steps/inline";
import type { TaskQueue } from "../steps/queue";
import type { RecipeReader } from "../steps/recipes";
import { pgStepRunStore, pgStepSweepStore } from "../steps/store";
import { getPool } from "./db";
import { verifyGoogleOidc } from "./google-oidc";
import { ownerRecipes as readOwnerRecipes } from "./recipe-source";
import type { StepsApiDeps } from "./steps-api";
import type { StepsWorkerDeps } from "./steps-worker-api";

/** 段階の実行器。今は偽物（AI を呼ばない）。本物（#38 の AiModel を包んだもの）に替えるのはここだけ。 */
function stepExecutor(): StepExecutor {
  return fakeExecutor;
}

/** その人の手順（表 `recipes`。無ければ既定を写して入れる。#37・#108）。DB が無ければ null。 */
function ownerRecipes(): RecipeReader | null {
  const pool = getPool();
  if (!pool) return null;
  return (owner) => readOwnerRecipes(pool, owner);
}

// inline のキューは Pool ごとに 1 つ（積んだ名前の重複の除去を要求の間で共有する）
let inline: { pool: object; queue: TaskQueue } | undefined;
// Cloud Tasks のキューは設定ごとに 1 つ（メタデータサーバーのアクセストークンを要求の間で使い回す）
let cloudTasks: { key: string; queue: TaskQueue } | undefined;

function cloudTasksQueue(config: CloudTasksConfig): TaskQueue {
  const key = `${config.queue}\n${config.workerUrl}\n${config.invokerServiceAccount}`;
  if (cloudTasks?.key !== key) cloudTasks = { key, queue: new CloudTasksQueue(config) };
  return cloudTasks.queue;
}

/** `/api/pages/{id}/steps/**` の実行時の依存（DB の接続・方式は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const stepsDeps: StepsApiDeps = {
  auth: () => getAuthProvider(),
  steps: () => {
    const pool = getPool();
    return pool ? pgStepRunStore(pool) : null;
  },
  recipes: ownerRecipes,
  queue: () => {
    const mode = resolveStepsMode(process.env);
    if (mode === "cloud-tasks") {
      const config = resolveCloudTasksConfig(process.env);
      return config ? cloudTasksQueue(config) : null;
    }
    if (mode !== "inline") return null;
    const pool = getPool();
    if (!pool) return null;
    if (inline?.pool !== pool) {
      inline = { pool, queue: createInlineQueue({ store: pgStepRunStore(pool), recipes: (owner) => readOwnerRecipes(pool, owner), executor: stepExecutor() }) };
    }
    return inline.queue;
  },
};

/** `/api/internal/steps/**`（worker の route）の実行時の依存。方式が cloud-tasks のときだけ開く。 */
export const stepsWorkerDeps: StepsWorkerDeps = {
  config: () => (resolveStepsMode(process.env) === "cloud-tasks" ? resolveCloudTasksConfig(process.env) : null),
  verify: (token, expected) => verifyGoogleOidc(token, expected),
  steps: () => {
    const pool = getPool();
    return pool ? { ...pgStepRunStore(pool), ...pgStepSweepStore(pool) } : null;
  },
  recipes: ownerRecipes,
  queue: (config) => cloudTasksQueue(config),
  executor: stepExecutor,
};
