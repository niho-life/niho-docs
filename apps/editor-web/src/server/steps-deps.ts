import "server-only";
import { getAiUsage, getEditorSettings, recordAiUsage } from "@niho/editor-store";
import { monthlyLimitUsd, resolveAiCompose } from "../ai/config";
import { getAuthProvider } from "../auth";
import { createAiStepExecutor } from "../steps/ai-executor";
import { CloudTasksQueue, resolveCloudTasksConfig, type CloudTasksConfig } from "../steps/cloud-tasks";
import type { StepExecutor } from "../steps/executor";
import { createInlineQueue, resolveStepsMode } from "../steps/inline";
import type { TaskQueue } from "../steps/queue";
import { recipesOf, type RecipeReader } from "../steps/recipes";
import { pgStepRunStore, pgStepSweepStore } from "../steps/store";
import { getPool } from "./db";
import { verifyGoogleOidc } from "./google-oidc";
import type { StepsApiDeps } from "./steps-api";
import type { StepsWorkerDeps } from "./steps-worker-api";

/**
 * 段階の実行器（本物。#38 の AI を包んだ ai-executor.ts）。AI・DB・上限は要求のたびに遅延して読む
 * （`EDITOR_AI_MODE` が無効なら段階は `ai_unavailable`、DB が無ければ `usage_unavailable` で失敗する）。
 * 開発と CI の `EDITOR_AI_MODE=fake` では偽物の 1 往復（`[fake]` の印が付く）。
 */
const aiStepExecutor: StepExecutor = createAiStepExecutor({
  compose: () => resolveAiCompose(process.env),
  usage: () => {
    const pool = getPool();
    return pool
      ? {
          get: (owner, month) => getAiUsage(pool, owner, month),
          record: (owner, month, delta) => recordAiUsage(pool, owner, month, delta),
        }
      : null;
  },
  limitUsd: () => monthlyLimitUsd(process.env),
  settings: () => {
    const pool = getPool();
    return pool ? (owner) => getEditorSettings(pool, owner) : null;
  },
});

function stepExecutor(): StepExecutor {
  return aiStepExecutor;
}

/** その人の手順（設定で変えたもの・足したものを既定にかぶせたもの。#108）。DB が無ければ null。 */
function ownerRecipes(): RecipeReader | null {
  const pool = getPool();
  if (!pool) return null;
  return async (owner) => recipesOf((await getEditorSettings(pool, owner)).recipes);
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
      inline = { pool, queue: createInlineQueue({ store: pgStepRunStore(pool), recipes: async (owner) => recipesOf((await getEditorSettings(pool, owner)).recipes), executor: stepExecutor() }) };
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
