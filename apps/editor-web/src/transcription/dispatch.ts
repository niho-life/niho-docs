import { resolveTranscriptionTasksConfig, transcriptionTaskName, type TranscriptionQueue } from "./cloud-tasks";

/**
 * 文字起こしの実行の呼び出し口（#36 段 2b）。開始の API が run を作ったあとに dispatch(runId) を呼ぶ。
 *
 * 方式は 2 つ:
 * - `inline`（開発と CI だけ）: 同じプロセスの中で、応答を返したあと（setImmediate）に実行（run.ts の executeRun）を非同期に走らせる。
 *   要求は待たない。**本番（`NODE_ENV=production`）では使わない**（Cloud Run は応答のあとに CPU を絞るので、同じプロセスで長い
 *   文字起こしを続けられる保証が無い）。
 * - `cloud-tasks`（本番）: Cloud Tasks に積み、同じサービスの OIDC で守った worker の route（`/api/internal/transcription/run`）が
 *   executeRun を呼ぶ。1 回の文字起こしは 1 つの task（docs/ops/editor-deploy.md §12）。
 *
 * 方式は `EDITOR_TRANSCRIBE_MODE` で選ぶ（手順の `EDITOR_STEPS_MODE` と同じ作法）。**未設定なら今までどおり**: 本番は null
 * （＝呼び出し口が無い。開始の API は 503 `transcription_unavailable`）、開発と CI は inline。
 */

export type DispatcherKind = "inline" | "cloud-tasks";

export type TranscriptionDispatcher = {
  readonly kind: DispatcherKind;
  /** run の実行を始める（積む）。積めなければ reject（呼び出し側が run を failed（internal）にする）。 */
  dispatch(runId: string): Promise<void>;
};

/**
 * 呼び出し口の方式。
 * - `inline`: 本番では null（偽物・同じプロセスの実行を本番に出さない）。それ以外は inline。
 * - `cloud-tasks`: キュー・worker の URL・OIDC のサービスアカウントの 3 つが揃い形が正しいときだけ（cloud-tasks.ts）。
 * - 未設定・空: これまでと同じ（本番は null、開発と CI は inline）。
 * - `off`・それ以外の値: null（閉じたまま）。
 */
export function resolveDispatcherKind(env: Readonly<Record<string, string | undefined>>): DispatcherKind | null {
  const mode = env.EDITOR_TRANSCRIBE_MODE?.trim() ?? "";
  switch (mode) {
    case "cloud-tasks":
      return resolveTranscriptionTasksConfig(env) ? "cloud-tasks" : null;
    case "inline":
    case "":
      return env.NODE_ENV === "production" ? null : "inline";
    default:
      return null;
  }
}

export type InlineDispatcherDeps = {
  /** run を実行する（executeRun。例外は外へ出さない約束だが、出たら failQueued と同じ扱いにする）。 */
  execute: (runId: string) => Promise<unknown>;
  /** 実行が想定外に失敗したとき: claim される前の run（世代 0）を failed（internal）にする（claim 後の失敗は executeRun が自分で失敗にする）。 */
  failQueued: (runId: string) => Promise<unknown>;
  /** 後で走らせる（既定は setImmediate。テストで差し替える）。 */
  schedule?: (task: () => void) => void;
  /** 想定外の失敗の知らせ（既定はログに名前だけを書く）。 */
  onError?: (error: unknown) => void;
};

function logError(error: unknown): void {
  console.error("editor-web: inline transcription failed", { name: error instanceof Error ? error.name : "unknown" });
}

/** inline の呼び出し口（開発と CI だけ）。 */
export function createInlineDispatcher(deps: InlineDispatcherDeps): TranscriptionDispatcher {
  const schedule = deps.schedule ?? ((task: () => void) => void setImmediate(task));
  const onError = deps.onError ?? logError;
  return {
    kind: "inline",
    async dispatch(runId: string): Promise<void> {
      schedule(() => {
        deps.execute(runId).catch(async (error: unknown) => {
          // 握りつぶさない: 知らせて、まだ claim されていなければ run を失敗にする（「もう一度」ができるように）
          onError(error);
          await deps.failQueued(runId).catch((failure: unknown) => onError(failure));
        });
      });
    },
  };
}

/**
 * Cloud Tasks の呼び出し口（本番）。積むのは queued の run（世代 0）なので、task の名前は開始と掃除で同じになる。
 * 既に同じ名前の task があれば積み済みとみなし、成功として返す（同じ run を 2 つ走らせない）。
 */
export function createCloudTasksDispatcher(deps: { queue: TranscriptionQueue }): TranscriptionDispatcher {
  return {
    kind: "cloud-tasks",
    async dispatch(runId: string): Promise<void> {
      await deps.queue.enqueue({ name: transcriptionTaskName(runId, 0), runId });
    },
  };
}
