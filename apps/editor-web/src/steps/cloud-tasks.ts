import { isPageId } from "@niho/editor-store";
import { CloudTasksClient, CloudTasksError, MetadataTokenSource, resolveTaskQueueConfig, type TaskQueueConfig } from "../server/cloud-tasks";
import type { StepTask, TaskQueue } from "./queue";

/**
 * 段階の task を Cloud Tasks に積む（#37。docs/architecture/editor-steps-execution.md §5.2）。
 * 積む口そのものは src/server/cloud-tasks.ts（文字起こし（#36）と共通）。ここで決めるのは、手順の環境変数の名前・worker の route の
 * path・task の本文（段階を指す 2 つの値だけ）・1 つの task の上限。
 */

export { CLOUD_TASKS_ORIGIN, CloudTasksError, METADATA_TOKEN_URL, MetadataTokenSource } from "../server/cloud-tasks";

/** worker の route（同じサービスの中）。 */
export const WORKER_RUN_PATH = "/api/internal/steps/run";
export const WORKER_SWEEP_PATH = "/api/internal/steps/sweep";
/** 1 つの task の上限（HTTP の task の最大の 30 分。1 つの段階の長さの上限になる）。 */
export const DISPATCH_DEADLINE_SECONDS = 1800;
export const DISPATCH_DEADLINE = `${DISPATCH_DEADLINE_SECONDS}s`;

export type CloudTasksConfig = TaskQueueConfig;

/**
 * `EDITOR_STEPS_QUEUE`・`EDITOR_STEPS_WORKER_URL`・`EDITOR_STEPS_INVOKER_SA` の 3 つが揃い、形が正しいときだけ設定を返す
 * （1 つでも欠けた・形が違えば null。手順は 503 のまま閉じる）。
 */
export function resolveCloudTasksConfig(env: Readonly<Record<string, string | undefined>>): CloudTasksConfig | null {
  return resolveTaskQueueConfig(env, {
    queue: "EDITOR_STEPS_QUEUE",
    workerUrl: "EDITOR_STEPS_WORKER_URL",
    invokerServiceAccount: "EDITOR_STEPS_INVOKER_SA",
  });
}

export type CloudTasksQueueOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** アクセストークン（既定はメタデータサーバー。同じ fetch・時計を使う）。 */
  tokens?: MetadataTokenSource;
};

/** Cloud Tasks のキュー（`TaskQueue` の実体）。 */
export class CloudTasksQueue implements TaskQueue {
  readonly #client: CloudTasksClient;

  constructor(config: CloudTasksConfig, options: CloudTasksQueueOptions = {}) {
    this.#client = new CloudTasksClient(config, options);
  }

  async enqueue(task: StepTask): Promise<{ deduplicated: boolean }> {
    const { name, runId, stepIndex, delaySeconds } = task;
    if (!isPageId(runId) || !Number.isSafeInteger(stepIndex) || stepIndex < 0) throw new CloudTasksError("tasks_invalid_task");
    return this.#client.createHttpTask({
      name,
      path: WORKER_RUN_PATH,
      // 本文は段階を指す 2 つの値だけ（ページの本文・秘密は入れない）
      payload: { runId, stepIndex },
      deadlineSeconds: DISPATCH_DEADLINE_SECONDS,
      ...(delaySeconds === undefined ? {} : { delaySeconds }),
    });
  }
}
