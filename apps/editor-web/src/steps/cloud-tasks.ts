import { isPageId } from "@niho/editor-store";
import type { StepTask, TaskQueue } from "./queue";

/**
 * Cloud Tasks に段階の task を積む（#37。docs/architecture/editor-steps-execution.md §5.2）。
 * task は同じサービスの内部の route（`/api/internal/steps/run`）を OIDC トークンつきで呼ぶ。名前は `taskName` の値で、
 * 同じ名前の 2 度目の積み込みは Cloud Tasks が `ALREADY_EXISTS` で拒む（＝積み済み）。依存を足さず REST を `fetch` で呼ぶ。
 * 失敗は短い code だけの例外（本文・トークンを入れない）。
 */

/** Cloud Tasks の REST（このホストだけを呼ぶ）。 */
export const CLOUD_TASKS_ORIGIN = "https://cloudtasks.googleapis.com";
/** Cloud Run のメタデータサーバーの、実行 ID のアクセストークン。 */
export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
/** worker の route（同じサービスの中）。 */
export const WORKER_RUN_PATH = "/api/internal/steps/run";
export const WORKER_SWEEP_PATH = "/api/internal/steps/sweep";
/** 1 つの task の上限（HTTP の task の最大の 30 分。1 つの段階の長さの上限になる）。 */
export const DISPATCH_DEADLINE = "1800s";
/** アクセストークンを、期限のこの時間前まで使う。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_MAX_CHARS = 16 * 1024;

const QUEUE_PATTERN = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z][a-z0-9-]{0,62}\/queues\/[A-Za-z0-9-]{1,100}$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const TASK_NAME_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export type CloudTasksConfig = {
  /** `projects/<p>/locations/<l>/queues/<q>`。 */
  queue: string;
  /** worker の基点（`https://<host>`。末尾の `/` なし）。OIDC の audience にも使う。 */
  workerUrl: string;
  /** task の OIDC トークンの身元（サービスアカウントのメール）。worker の route がこの 1 つだけを通す。 */
  invokerServiceAccount: string;
};

/** worker の基点。`https://<host>`（末尾の `/` は可）だけ。path・query・認証情報つきは受けない。 */
function parseWorkerUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // 書いたとおりの origin だけ（大文字・既定の port・path・query・fragment を正規化して受けることはしない）
  if (value !== url.origin && value !== `${url.origin}/`) return null;
  return url.origin;
}

/**
 * `EDITOR_STEPS_QUEUE`・`EDITOR_STEPS_WORKER_URL`・`EDITOR_STEPS_INVOKER_SA` の 3 つが揃い、形が正しいときだけ設定を返す
 * （1 つでも欠けた・形が違えば null。手順は 503 のまま閉じる）。
 */
export function resolveCloudTasksConfig(env: Readonly<Record<string, string | undefined>>): CloudTasksConfig | null {
  const queue = env.EDITOR_STEPS_QUEUE;
  const invokerServiceAccount = env.EDITOR_STEPS_INVOKER_SA;
  const workerUrl = parseWorkerUrl(env.EDITOR_STEPS_WORKER_URL);
  if (!queue || !QUEUE_PATTERN.test(queue)) return null;
  if (!invokerServiceAccount || !SERVICE_ACCOUNT_PATTERN.test(invokerServiceAccount)) return null;
  if (!workerUrl) return null;
  return { queue, workerUrl, invokerServiceAccount };
}

/** Cloud Tasks・メタデータサーバーの失敗。`code` は短い英小文字と数字だけ（応答の本文・トークンを入れない）。 */
export class CloudTasksError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`cloud tasks: ${code}`);
    this.name = "CloudTasksError";
    this.code = code;
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export type TokenSourceOptions = { fetch?: typeof fetch; now?: () => number };

/** Cloud Run の実行 ID のアクセストークン（メタデータサーバーから。期限の 60 秒前まで使い回す。並行の取得は 1 本にまとめる）。 */
export class MetadataTokenSource {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cached: { value: string; expiresAt: number } | undefined;
  #inflight: Promise<string> | undefined;

  constructor(options: TokenSourceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async token(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.value;
    this.#inflight ??= this.#load().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** 使ったトークンが拒まれた（401）。次は取り直す。 */
  invalidate(): void {
    this.#cached = undefined;
  }

  async #load(): Promise<string> {
    const requestedAt = this.#now();
    let response: Response;
    try {
      response = await this.#fetch(METADATA_TOKEN_URL, {
        headers: { "Metadata-Flavor": "Google" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CloudTasksError("tasks_token_network");
    }
    if (!response.ok) {
      await discard(response);
      throw new CloudTasksError(`tasks_token_http_${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CloudTasksError("tasks_token_invalid");
    }
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const { access_token: value, expires_in: expiresIn } = record;
    if (typeof value !== "string" || !ACCESS_TOKEN_PATTERN.test(value) || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new CloudTasksError("tasks_token_invalid");
    }
    this.#cached = { value, expiresAt: requestedAt + expiresIn * 1000 };
    return value;
  }
}

/** 失敗の応答の `error.status`（Google の API の形。読めなければ null）。 */
async function errorStatus(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.length > ERROR_BODY_MAX_CHARS) return null;
    const body: unknown = JSON.parse(text);
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

export type CloudTasksQueueOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** アクセストークン（既定はメタデータサーバー。同じ fetch・時計を使う）。 */
  tokens?: MetadataTokenSource;
};

/** Cloud Tasks のキュー（`TaskQueue` の実体）。 */
export class CloudTasksQueue implements TaskQueue {
  readonly #config: CloudTasksConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tokens: MetadataTokenSource;

  constructor(config: CloudTasksConfig, options: CloudTasksQueueOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#tokens = options.tokens ?? new MetadataTokenSource({ fetch: options.fetch, now: options.now });
  }

  async enqueue(task: StepTask): Promise<{ deduplicated: boolean }> {
    const { name, runId, stepIndex, delaySeconds } = task;
    if (!TASK_NAME_PATTERN.test(name) || !isPageId(runId) || !Number.isSafeInteger(stepIndex) || stepIndex < 0) {
      throw new CloudTasksError("tasks_invalid_task");
    }
    if (delaySeconds !== undefined && !(Number.isFinite(delaySeconds) && delaySeconds >= 0)) throw new CloudTasksError("tasks_invalid_task");
    const { queue, workerUrl, invokerServiceAccount } = this.#config;
    const body = {
      task: {
        name: `${queue}/tasks/${name}`,
        // 再試行の間隔は、実行する時刻で表す
        ...(delaySeconds ? { scheduleTime: new Date(this.#now() + delaySeconds * 1000).toISOString() } : {}),
        dispatchDeadline: DISPATCH_DEADLINE,
        httpRequest: {
          url: `${workerUrl}${WORKER_RUN_PATH}`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          // 本文は段階を指す 2 つの値だけ（ページの本文・秘密は入れない）
          body: Buffer.from(JSON.stringify({ runId, stepIndex }), "utf8").toString("base64"),
          oidcToken: { serviceAccountEmail: invokerServiceAccount, audience: workerUrl },
        },
      },
    };
    const accessToken = await this.#tokens.token();
    let response: Response;
    try {
      response = await this.#fetch(`${CLOUD_TASKS_ORIGIN}/v2/${queue}/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CloudTasksError("tasks_network");
    }
    if (response.ok) {
      await discard(response);
      return { deduplicated: false };
    }
    // 409 は ALREADY_EXISTS（同じ名前が積まれている・最近まであった）のときだけ積み済みとみなす（ABORTED も 409 になる）
    if (response.status === 409) {
      if ((await errorStatus(response)) === "ALREADY_EXISTS") return { deduplicated: true };
    } else {
      await discard(response);
    }
    if (response.status === 401) this.#tokens.invalidate();
    throw new CloudTasksError(`tasks_http_${response.status}`);
  }
}
