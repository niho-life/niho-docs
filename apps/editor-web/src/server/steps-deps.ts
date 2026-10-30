import "server-only";
import { getAuthProvider } from "../auth";
import { createInlineQueue, resolveStepsMode } from "../steps/inline";
import type { TaskQueue } from "../steps/queue";
import { pgStepRunStore } from "../steps/store";
import { getPool } from "./db";
import type { StepsApiDeps } from "./steps-api";

// inline のキューは Pool ごとに 1 つ（積んだ名前の重複の除去を要求の間で共有する）
let inline: { pool: object; queue: TaskQueue } | undefined;

/** `/api/pages/{id}/steps/**` の実行時の依存（DB の接続・方式は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const stepsDeps: StepsApiDeps = {
  auth: () => getAuthProvider(),
  steps: () => {
    const pool = getPool();
    return pool ? pgStepRunStore(pool) : null;
  },
  queue: () => {
    if (resolveStepsMode(process.env) !== "inline") return null;
    const pool = getPool();
    if (!pool) return null;
    if (inline?.pool !== pool) inline = { pool, queue: createInlineQueue({ store: pgStepRunStore(pool) }) };
    return inline.queue;
  },
};
