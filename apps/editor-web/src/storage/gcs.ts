import { StorageError, isObjectPath, type ObjectStorage, type ReadObject, type StartUploadInput, type StoredObject, type UploadTicket } from "./types";

/**
 * Google Cloud Storage の保存先（`EDITOR_STORAGE=gcs`）。依存を足さず、fetch と Cloud Run のメタデータサーバーの token だけで呼ぶ。
 *
 * **実際の GCS では未検証**（bucket がまだ無いため。テストは fetch を差し替えて、送る要求の形と応答の扱いだけを確かめている）。
 *
 * 実行 ID（Cloud Run のサービスアカウント）は bucket に作成と閲覧だけ（削除・上書き不可）で、署名付き URL（V4 の署名）の権限も無い前提。
 * そのため、サーバーが自分の資格情報で resumable upload のセッションを始め、そのセッション URI をブラウザに渡して直接 PUT させる
 * （Cloud Run の要求の大きさの上限を避ける）。依拠している API の仕様:
 * - 開始: `POST https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=resumable&name={object}`、
 *   header `X-Upload-Content-Type`（object の種類）・`X-Upload-Content-Length`（大きさ。超える PUT は保存先が断る）。
 *   成功は 200 で、`Location` header がセッション URI（https://cloud.google.com/storage/docs/performing-resumable-uploads）。
 *   セッション URI は 1 週間で使えなくなる。
 * - `ifGenerationMatch=0`: 同じ名前の object が無いときだけ作る（上書きしない。https://cloud.google.com/storage/docs/request-preconditions）。
 * - CORS: 開始の要求の `Origin` header が、そのセッション URI へのブラウザからの要求に返す origin になる
 *   （https://cloud.google.com/storage/docs/cross-origin）。bucket の CORS の設定もあわせて要る（README の「bucket に要求する設定」）。
 * - 確認: `GET https://storage.googleapis.com/storage/v1/b/{bucket}/o/{object（URL エンコード）}` の `size`（10 進の文字列）・`contentType`。
 * - 読み取り（画像の中継 #33・文字起こし #36 段 2b）: 同じ URL に `?alt=media` を付けた `GET`（同じ token の道）。応答の本文がそのまま
 *   object の中身で、`Content-Type` が種類、大きさは `Content-Length`（無ければ `x-goog-stored-content-length`）。`Accept-Encoding: identity`
 *   （中身をそのまま・`Content-Length` 付きで受ける）。時間切れは header が届くまでだけで、本文の読み取りには時間切れをかけない
 *   （長い音声をエンジンへ流し終えるまでの時間は、呼び出し側の時間切れが決める）。署名付き URL は作らない（実行 ID に署名の権限が無い前提）。
 * - token: メタデータサーバー `GET {METADATA_TOKEN_URL}`（header `Metadata-Flavor: Google`）の `access_token`・`expires_in`（秒）。
 *
 * 失敗の写し方: 届かない・時間切れ（30 秒）・401・403・408・429・5xx は unavailable、それ以外の 4xx は rejected、確認の 404 は null。
 * token・セッション URI・bucket 名・object の場所は、ログにもエラーにも出さない（このファイルはログを書かない）。
 * リダイレクトは辿らない（Authorization を別の場所へ送らない）。
 */

export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
export const GCS_UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1/b/";
export const GCS_JSON_BASE = "https://storage.googleapis.com/storage/v1/b/";
/** セッション URI の origin（これ以外の Location はブラウザに渡さない）。 */
const SESSION_ORIGIN = "https://storage.googleapis.com";
/** 1 回の要求の時間切れ。 */
export const GCS_TIMEOUT_MS = 30_000;
/** resumable upload のセッション URI が使える期間（GCS の仕様で 1 週間）。 */
export const GCS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** token の期限の少し前に取り直す（秒）。 */
const TOKEN_REFRESH_MARGIN_SEC = 60;

type Fetch = typeof fetch;

/** 保存先を呼ぶための access token（Bearer）を返す。失敗は StorageError（unavailable）。 */
export type AccessTokenProvider = () => Promise<string>;

/** header に入れてよい 1 語（空白・改行・制御文字なし）。 */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;

async function send(doFetch: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // 中身（URL・token を含み得る）は捨てる
    throw new StorageError("unavailable");
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new StorageError("unavailable");
  }
}

function failure(status: number): StorageError {
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return new StorageError("unavailable");
  return new StorageError("rejected");
}

/**
 * Cloud Run（GCE）のメタデータサーバーから既定のサービスアカウントの token を取る。期限の 60 秒前まではメモリに持って使い回し、
 * 同時に呼ばれても取りに行くのは 1 回だけ。
 */
export function createMetadataTokenProvider(options: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {}): AccessTokenProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GCS_TIMEOUT_MS;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  const load = async (): Promise<string> => {
    const response = await send(doFetch, METADATA_TOKEN_URL, { method: "GET", headers: { "Metadata-Flavor": "Google" } }, timeoutMs);
    if (!response.ok) {
      await discard(response);
      throw new StorageError("unavailable");
    }
    const body = await readJson(response);
    const token = typeof body === "object" && body !== null ? (body as { access_token?: unknown }).access_token : undefined;
    const expiresIn = typeof body === "object" && body !== null ? (body as { expires_in?: unknown }).expires_in : undefined;
    if (typeof token !== "string" || !HEADER_TOKEN.test(token) || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new StorageError("unavailable");
    }
    cached = { token, expiresAtMs: now() + Math.max(0, expiresIn - TOKEN_REFRESH_MARGIN_SEC) * 1000 };
    return token;
  };

  return async () => {
    if (cached && cached.expiresAtMs > now()) return cached.token;
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export type GcsStorageOptions = {
  bucket: string;
  fetch?: Fetch;
  accessToken?: AccessTokenProvider;
  now?: () => number;
  timeoutMs?: number;
};

function validOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

export function createGcsStorage(options: GcsStorageOptions): ObjectStorage {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GCS_TIMEOUT_MS;
  const accessToken = options.accessToken ?? createMetadataTokenProvider({ fetch: doFetch, now, timeoutMs });
  const bucket = encodeURIComponent(options.bucket);

  const authorization = async (): Promise<string> => {
    let token: string;
    try {
      token = await accessToken();
    } catch {
      throw new StorageError("unavailable");
    }
    if (typeof token !== "string" || !HEADER_TOKEN.test(token)) throw new StorageError("unavailable");
    return `Bearer ${token}`;
  };

  return {
    kind: "gcs",
    async startUpload(input: StartUploadInput): Promise<UploadTicket> {
      if (
        !isObjectPath(input.objectPath) ||
        typeof input.contentType !== "string" ||
        !HEADER_TOKEN.test(input.contentType) ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 0
      ) {
        throw new StorageError("rejected");
      }
      const headers: Record<string, string> = {
        Authorization: await authorization(),
        "X-Upload-Content-Type": input.contentType,
        "X-Upload-Content-Length": String(input.sizeBytes),
      };
      const origin = validOrigin(input.origin);
      if (origin !== null) headers.Origin = origin;
      const url = `${GCS_UPLOAD_BASE}${bucket}/o?uploadType=resumable&name=${encodeURIComponent(input.objectPath)}&ifGenerationMatch=0`;
      const response = await send(doFetch, url, { method: "POST", headers }, timeoutMs);
      await discard(response);
      if (!response.ok) throw failure(response.status);
      const location = response.headers.get("location");
      let session: URL;
      try {
        session = new URL(location ?? "");
      } catch {
        throw new StorageError("unavailable");
      }
      if (session.origin !== SESSION_ORIGIN) throw new StorageError("unavailable");
      return {
        url: session.href,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: new Date(now() + GCS_SESSION_TTL_MS).toISOString(),
      };
    },
    async stat(objectPath: string): Promise<StoredObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const url = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(objectPath)}?fields=size%2CcontentType`;
      const response = await send(doFetch, url, { method: "GET", headers: { Authorization: await authorization() } }, timeoutMs);
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw failure(response.status);
      }
      const body = await readJson(response);
      if (typeof body !== "object" || body === null) throw new StorageError("unavailable");
      const { size, contentType } = body as { size?: unknown; contentType?: unknown };
      const sizeBytes = typeof size === "string" && /^\d{1,16}$/.test(size) ? Number(size) : Number.NaN;
      if (!Number.isSafeInteger(sizeBytes)) throw new StorageError("unavailable");
      return { sizeBytes, contentType: typeof contentType === "string" ? contentType : null };
    },
    async readObject(objectPath: string): Promise<ReadObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const url = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
      const headers = { Authorization: await authorization(), "Accept-Encoding": "identity" };
      // 時間切れは header が届くまで（本文を読む間は切らない。届いたら timer を止める）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
      } catch {
        // 中身（URL・token を含み得る）は捨てる
        throw new StorageError("unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw failure(response.status);
      }
      const length = response.headers.get("content-length") ?? response.headers.get("x-goog-stored-content-length");
      const sizeBytes = length !== null && /^\d{1,16}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
      if (!response.body || !Number.isSafeInteger(sizeBytes)) {
        await discard(response);
        throw new StorageError("unavailable");
      }
      return { body: response.body, contentType: response.headers.get("content-type"), sizeBytes };
    },
  };
}
