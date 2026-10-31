/**
 * Cloud Tasks の HTTP の task を積む口（#37 が手順で、#36 が文字起こしで使う。docs/architecture/editor-steps-execution.md §5.2）。
 * task は同じサービスの内部の route を OIDC トークンつきで呼ぶ。名前は task ごとに決め、同じ名前の 2 度目の積み込みは
 * Cloud Tasks が `ALREADY_EXISTS` で拒む（＝積み済み）。依存を足さず REST を `fetch` で呼ぶ。
 * 失敗は短い code だけの例外（本文・トークンを入れない）。
 *
 * 使う側（src/steps/cloud-tasks.ts・src/transcription/cloud-tasks.ts）が、route の path・task の本文・1 つの task の上限を決める。
 */

/** Cloud Tasks の REST（このホストだけを呼ぶ）。 */
export const CLOUD_TASKS_ORIGIN = "https://cloudtasks.googleapis.com";
/** Cloud Run のメタデータサーバーの、実行 ID のアクセストークン。 */
export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
/** HTTP の task の `dispatchDeadline` の上限（秒。Cloud Tasks の決まり）。 */
export const MAX_DISPATCH_DEADLINE_SECONDS = 1800;
/** アクセストークンを、期限のこの時間前まで使う。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_MAX_CHARS = 16 * 1024;

const QUEUE_PATTERN = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z][a-z0-9-]{0,62}\/queues\/[A-Za-z0-9-]{1,100}$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const TASK_NAME_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export type TaskQueueConfig = {
  /** `projects/<p>/locations/<l>/queues/<q>`。 */
  queue: string;
  /** worker の基点（`https://<host>`。末尾の `/` なし）。OIDC の audience にも使う。 */
  workerUrl: string;
  /** task の OIDC トークンの身元（サービスアカウントのメール）。worker の route がこの 1 つだけを通す。 */
  invokerServiceAccount: string;
};

/** 設定を読む環境変数の名前（手順と文字起こしで別の 3 つ）。 */
export type TaskQueueEnvNames = { queue: string; workerUrl: string; invokerServiceAccount: string };

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
 * キュー・worker の URL・OIDC のサービスアカウントの 3 つが揃い、形が正しいときだけ設定を返す
 * （1 つでも欠けた・形が違えば null。呼び出し側はその機能を閉じたままにする）。
 */
export function resolveTaskQueueConfig(env: Readonly<Record<string, string | undefined>>, names: TaskQueueEnvNames): TaskQueueConfig | null {
  const queue = env[names.queue];
  const invokerServiceAccount = env[names.invokerServiceAccount];
  const workerUrl = parseWorkerUrl(env[names.workerUrl]);
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

export type HttpTaskRequest = {
  /** キューの中で一意な名前（英数字・`-`・`_` の 500 文字まで）。同じ名前の 2 度目は積み済み。 */
  name: string;
  /** worker の route の path（`/api/internal/...`。worker の URL に続ける）。 */
  path: string;
  /** task の本文（JSON にして base64 で渡す。ページの本文・秘密を入れない）。 */
  payload: unknown;
  /** 1 つの task の実行の上限（秒。1〜1800）。 */
  deadlineSeconds: number;
  /** 実行を遅らせる秒数（再試行の間隔）。 */
  delaySeconds?: number;
};

export type CloudTasksClientOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** アクセストークン（既定はメタデータサーバー。同じ fetch・時計を使う）。 */
  tokens?: MetadataTokenSource;
};

/** 1 つのキューに HTTP の task を積む口。 */
export class CloudTasksClient {
  readonly #config: TaskQueueConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tokens: MetadataTokenSource;

  constructor(config: TaskQueueConfig, options: CloudTasksClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#tokens = options.tokens ?? new MetadataTokenSource({ fetch: options.fetch, now: options.now });
  }

  /** task を積む。既に同じ名前があれば `deduplicated: true`。失敗は CloudTasksError（短い code だけ）。 */
  async createHttpTask(request: HttpTaskRequest): Promise<{ deduplicated: boolean }> {
    const { name, path, payload, deadlineSeconds, delaySeconds } = request;
    // 形の検査は、トークンの取得より先（不正な task で外へ 1 度も出さない）
    if (!TASK_NAME_PATTERN.test(name)) throw new CloudTasksError("tasks_invalid_task");
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > MAX_DISPATCH_DEADLINE_SECONDS) {
      throw new CloudTasksError("tasks_invalid_task");
    }
    if (delaySeconds !== undefined && !(Number.isFinite(delaySeconds) && delaySeconds >= 0)) throw new CloudTasksError("tasks_invalid_task");
    const { queue, workerUrl, invokerServiceAccount } = this.#config;
    const body = {
      task: {
        name: `${queue}/tasks/${name}`,
        // 再試行の間隔は、実行する時刻で表す
        ...(delaySeconds ? { scheduleTime: new Date(this.#now() + delaySeconds * 1000).toISOString() } : {}),
        dispatchDeadline: `${deadlineSeconds}s`,
        httpRequest: {
          url: `${workerUrl}${path}`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
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
