import { isPageId } from "@niho/editor-store";
import {
  CloudTasksClient,
  CloudTasksError,
  MAX_DISPATCH_DEADLINE_SECONDS,
  MetadataTokenSource,
  resolveTaskQueueConfig,
  type TaskQueueConfig,
} from "../server/cloud-tasks";

/**
 * 文字起こしの run を Cloud Tasks に積む（#36 段 2b）。積む口そのものは src/server/cloud-tasks.ts（手順（#37）と共通）。
 * ここで決めるのは、文字起こしの環境変数の名前・worker の route の path・task の本文（run の id だけ）・1 つの task の上限。
 *
 * 1 つの文字起こしは最長 `EDITOR_TRANSCRIBE_TIMEOUT_SEC`（既定 1200 秒）かかるので、手順の段階（すぐ終わる）とはキューを分ける
 * （再試行の間隔・同時に走る数・1 つの task の上限が違う。docs/ops/editor-deploy.md §12）。
 */

/** worker の route（同じサービスの中）。 */
export const TRANSCRIBE_RUN_PATH = "/api/internal/transcription/run";
export const TRANSCRIBE_SWEEP_PATH = "/api/internal/transcription/sweep";

/**
 * 文字起こしの時間切れに足す余裕（秒）。task の上限（`dispatchDeadline`）はこれだけ長くする。
 * エンジンの時間切れ（executeRun の AbortSignal）が先に当たり、run が `engine_timeout` で失敗して終わるようにするため。
 * Cloud Run の要求の上限も同じ考えで決める（scripts/editor-deploy/lib.sh の `service_request_timeout`）。
 */
export const DISPATCH_MARGIN_SECONDS = 120;

export type TranscriptionTasksConfig = TaskQueueConfig;

/**
 * `EDITOR_TRANSCRIBE_QUEUE`・`EDITOR_TRANSCRIBE_WORKER_URL`・`EDITOR_TRANSCRIBE_INVOKER_SA` の 3 つが揃い、形が正しいときだけ
 * 設定を返す（1 つでも欠けた・形が違えば null。文字起こしは 503 のまま閉じる）。
 */
export function resolveTranscriptionTasksConfig(env: Readonly<Record<string, string | undefined>>): TranscriptionTasksConfig | null {
  return resolveTaskQueueConfig(env, {
    queue: "EDITOR_TRANSCRIBE_QUEUE",
    workerUrl: "EDITOR_TRANSCRIBE_WORKER_URL",
    invokerServiceAccount: "EDITOR_TRANSCRIBE_INVOKER_SA",
  });
}

/**
 * task の名前（決め方はここだけ）。run の id と世代を入れる。積むのは queued の run（世代 0）なので、開始の積み込みと掃除の
 * 積み直しが同じ名前になり、まだ積まれていれば Cloud Tasks が重複として拒む（＝積み済み）。
 * Cloud Tasks の task 名に使える文字（英数字・`-`・`_`）だけ。run の id は UUID（長さが決まっている）なので区切りは曖昧にならない。
 */
export function transcriptionTaskName(runId: string, generation: number): string {
  return `${runId}-${generation}`;
}

/** 1 つの task の上限（秒）。文字起こしの時間切れ ＋ 余裕。HTTP の task の上限（1800 秒）で止める。 */
export function dispatchDeadlineSeconds(timeoutMs: number): number {
  const seconds = Math.ceil(timeoutMs / 1000) + DISPATCH_MARGIN_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_DISPATCH_DEADLINE_SECONDS);
}

/** run を 1 つ実行する task（本文・秘密は入れない）。 */
export type TranscriptionTask = { name: string; runId: string };

export type TranscriptionQueue = {
  /** 同じ名前の task は 1 度だけ積む（2 度目からは `deduplicated: true`）。 */
  enqueue(task: TranscriptionTask): Promise<{ deduplicated: boolean }>;
};

export type TranscriptionQueueOptions = {
  /** 1 回の文字起こしの時間切れ（ミリ秒。設定の `EDITOR_TRANSCRIBE_TIMEOUT_SEC`）。task の上限をこれから決める。 */
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** アクセストークン（既定はメタデータサーバー。同じ fetch・時計を使う）。 */
  tokens?: MetadataTokenSource;
};

/** Cloud Tasks のキュー（`TranscriptionQueue` の実体）。 */
export class CloudTasksTranscriptionQueue implements TranscriptionQueue {
  readonly #client: CloudTasksClient;
  readonly #deadlineSeconds: number;

  constructor(config: TranscriptionTasksConfig, options: TranscriptionQueueOptions) {
    this.#client = new CloudTasksClient(config, options);
    this.#deadlineSeconds = dispatchDeadlineSeconds(options.timeoutMs);
  }

  async enqueue(task: TranscriptionTask): Promise<{ deduplicated: boolean }> {
    if (!isPageId(task.runId)) throw new CloudTasksError("tasks_invalid_task");
    return this.#client.createHttpTask({
      name: task.name,
      path: TRANSCRIBE_RUN_PATH,
      // 本文は run を指す 1 つの値だけ（音声・鍵・ページの本文は入れない）
      payload: { runId: task.runId },
      deadlineSeconds: this.#deadlineSeconds,
    });
  }
}
