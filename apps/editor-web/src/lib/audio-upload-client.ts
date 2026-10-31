/**
 * ブラウザから録音の音声をアップロードする薄い関数（#36 段 2a）。画面への組み込みは段 3。
 * 流れ: getAudioLimits（上限を出す）→ startAudioUpload（録音ページと ticket）→ putAudio（ticket の url へ直接 PUT。保存先は
 * 本番では GCS、開発では同じ origin の偽物）→ completeAudioUpload（大きさを確かめて uploaded にする）。
 *
 * - sha256 は呼び出し側が渡す申告値（サーバーは検証しない）。2 GiB までのファイルのハッシュをブラウザで計算する部分は、
 *   画面の設計（進み具合・中断）が要るので段 3 で扱う。
 * - PUT の進み具合は今は扱わない。ticket の url は持っている人がアップロードできる値なので、ログ・保存・送信に使わない。
 * - API の呼び出しは同じ origin（cookie・token はここでは扱わない）。PUT は credentials を付けない（保存先は別の origin）。
 */

export type AudioLimits = {
  maxBytes: number;
  maxDurationSec: number;
  retentionDays: number;
  extensions: string[];
  contentTypes: string[];
};

export type AudioUploadTicket = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  /** 申告の大きさ（この大きさを PUT する）。 */
  maxBytes: number;
};

export type AudioStartRequest = {
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  lang?: "ja" | "en";
  durationSec?: number;
};

/** 開始の結果。`upload` が null なら既に済んでいる（同じ Idempotency-Key の再送）。録音は GET の応答と同じ形。 */
export type AudioStartResponse = {
  status: 200 | 201;
  page: { id: string; kind: "rec"; title: string; lang: "ja" | "en"; createdAt: string; updatedAt: string };
  recording: Record<string, unknown> & { audio: { status: "uploading" | "uploaded"; bytes: number; contentType: string; expiresAt: string | null } | null };
  speakers: unknown[];
  upload: AudioUploadTicket | null;
};

export type AudioCompleteResponse = { recording: AudioStartResponse["recording"]; speakers: unknown[] };

/** API の失敗。`error` と `reason` はサーバーの短い code（`bad_request`・`too_large`・`incomplete`・`size_mismatch` など）。 */
export class AudioUploadError extends Error {
  override readonly name = "AudioUploadError";
  constructor(
    readonly status: number,
    readonly error: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`audio upload failed with ${status}${error ? ` (${error}${reason ? `: ${reason}` : ""})` : ""}`);
  }
}

type FetchLike = typeof fetch;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<AudioUploadError> {
  const body = await readJson(response);
  const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
  const reason = isPlainObject(body) && typeof body.reason === "string" ? body.reason : null;
  return new AudioUploadError(response.status, error, reason);
}

function isTicket(value: unknown): value is AudioUploadTicket {
  if (!isPlainObject(value) || value.method !== "PUT" || typeof value.url !== "string" || typeof value.expiresAt !== "string") return false;
  if (typeof value.maxBytes !== "number" || !isPlainObject(value.headers)) return false;
  return Object.values(value.headers).every((header) => typeof header === "string");
}

/** 上限と受け付ける形式。 */
export async function getAudioLimits(fetchImpl: FetchLike = fetch): Promise<AudioLimits> {
  const response = await fetchImpl("/api/recordings/audio/limits", { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const body = await readJson(response);
  if (
    !isPlainObject(body) ||
    typeof body.maxBytes !== "number" ||
    typeof body.maxDurationSec !== "number" ||
    typeof body.retentionDays !== "number" ||
    !Array.isArray(body.extensions) ||
    !Array.isArray(body.contentTypes)
  ) {
    throw new AudioUploadError(500);
  }
  return {
    maxBytes: body.maxBytes,
    maxDurationSec: body.maxDurationSec,
    retentionDays: body.retentionDays,
    extensions: body.extensions.filter((item): item is string => typeof item === "string"),
    contentTypes: body.contentTypes.filter((item): item is string => typeof item === "string"),
  };
}

/** アップロードを始める。同じファイルの再送には同じ idempotencyKey（UUID）を渡す（同じ録音ページが返る）。 */
export async function startAudioUpload(
  input: AudioStartRequest,
  options: { idempotencyKey?: string; fetch?: FetchLike } = {},
): Promise<AudioStartResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey !== undefined) {
    if (!UUID_PATTERN.test(options.idempotencyKey)) throw new TypeError("idempotencyKey must be a UUID");
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const body: Record<string, unknown> = { name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 };
  if (input.lang !== undefined) body.lang = input.lang;
  if (input.durationSec !== undefined) body.durationSec = input.durationSec;
  const response = await fetchImpl("/api/recordings/audio/start", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 201) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPlainObject(data.page) || typeof data.page.id !== "string" || !isPlainObject(data.recording)) {
    throw new AudioUploadError(500);
  }
  if (data.upload !== null && !isTicket(data.upload)) throw new AudioUploadError(500);
  return {
    status: response.status as 200 | 201,
    page: data.page as AudioStartResponse["page"],
    recording: data.recording as AudioStartResponse["recording"],
    speakers: Array.isArray(data.speakers) ? data.speakers : [],
    upload: data.upload as AudioUploadTicket | null,
  };
}

/** ticket の url へ音声を直接 PUT する。412（既に置いてある）は成功と同じに扱い、続けて完了を呼べばよい。 */
export async function putAudio(ticket: AudioUploadTicket, body: Blob, fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl(ticket.url, { method: "PUT", headers: { ...ticket.headers }, body, credentials: "omit", cache: "no-store" });
  await response.body?.cancel().catch(() => undefined);
  if (response.ok || response.status === 412) return;
  // 保存先の応答の本文は読まない（中身を出さない）
  throw new AudioUploadError(response.status);
}

/** アップロードの完了。保存先に無い・大きさが違うは AudioUploadError（409、reason が missing・size_mismatch）。 */
export async function completeAudioUpload(pageId: string, fetchImpl: FetchLike = fetch): Promise<AudioCompleteResponse> {
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/recording/audio/complete`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPlainObject(data.recording)) throw new AudioUploadError(500);
  return { recording: data.recording as AudioCompleteResponse["recording"], speakers: Array.isArray(data.speakers) ? data.speakers : [] };
}
