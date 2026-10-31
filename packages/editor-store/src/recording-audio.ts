import { isPageId } from "./store.ts";
import {
  CONTROL_CHARACTERS,
  GET_SQL,
  INSERT_PAGE_SQL,
  InvalidRecordingError,
  RECORDING_COLUMNS,
  RECORDING_SOURCE_NAME_MAX_CHARS,
  SHA256,
  TOUCH_PAGE_SQL,
  assertOwner,
  charCount,
  isInvalidTextRepresentation,
  isStorableText,
  rollback,
  toRecording,
  type Connectable,
  type Recording,
  type RecordingAudioStatus,
  type RecordingPage,
  type RecordingRow,
} from "./recordings.ts";
import type { PoolClient } from "pg";
import type { OwnerId, PageLang, Queryable } from "./types.ts";

/**
 * 録音の音声のアップロード（#36 段 2a。migrations/0008_recording_audio.sql）。
 *
 * 流れ: 開始（startAudioRecording）で録音ページ・音声の資産（assets）・録音（page_recordings。状態 uploading）を 1 つの transaction で作る
 * → ブラウザが保存先へ直接アップロードする → 完了（completeAudioUpload）で、保存先にある object の大きさが申告どおりなら uploaded にする。
 * 資産の bytes・sha256・content_type はクライアントの申告の値（サーバーは中身を読まず、sha256 を検証しない）。
 * 音声を消すのは bucket のライフサイクル規則で、ここでは何も消さない（期限 audio_expires_at を持つだけ）。
 * 読み書きは全て本人の・ゴミ箱でないページだけ（別の人・存在しない・UUID として不正な id・削除済み・音声の無いページは null）。
 */

/** 音声の object を置く場所の接頭辞（bucket のライフサイクル規則の prefix と同じ）。 */
export const AUDIO_OBJECT_PREFIX = "audio/";
/** content type の文字数の上限（0001 の assets.content_type の CHECK と同じ）。 */
const CONTENT_TYPE_MAX_CHARS = 255;
/** 題名の上限（0001 の pages.title の CHECK と同じ）。 */
const PAGE_TITLE_MAX_CHARS = 500;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** 音声の object の場所（`audio/{asset id}`）。asset id は UUID だけ（それ以外は TypeError）。 */
export function audioObjectPath(assetId: string): string {
  if (typeof assetId !== "string" || !isPageId(assetId)) throw new TypeError("editor-store: asset id must be a UUID");
  return `${AUDIO_OBJECT_PREFIX}${assetId.toLowerCase()}`;
}

export type StartAudioRecordingInput = {
  /** 資産の id（呼び出し側が先に作る。保存先の場所 `audio/{assetId}` に使う）。 */
  assetId: string;
  /** ページの題名（ファイル名からパスと拡張子を除いたもの）。 */
  title: string;
  lang: PageLang;
  /** 元のファイルの名前（パス・制御文字なし、200 文字まで）。 */
  sourceName: string;
  /** 申告の content type（小文字に正規化したもの）。 */
  contentType: string;
  /** 申告の大きさ（バイト）。 */
  bytes: number;
  /** 申告の SHA-256（小文字 16 進 64 桁。サーバーは検証しない）。 */
  sha256: string;
  /** 申告の長さ（秒）。不明なら null。 */
  durationSec: number | null;
  /** 冪等キー（UUID）。無ければ null（同じ要求の再送でも別の録音になる）。 */
  uploadKey: string | null;
  /** 開始の要求の正規化した内容の SHA-256（同じキーで内容が違う要求を見分ける）。 */
  requestHash: string;
  /** 音声を保持する日数（期限 = 作成の時刻 + この日数）。 */
  retentionDays: number;
};

export type StartedAudioRecording = {
  /** created: 今作った / existing: 同じキー・同じ内容の要求で作ったもの（何も書かない）。 */
  status: "created" | "existing";
  page: RecordingPage;
  recording: Recording;
  /** 資産の id（保存先の場所を引く。応答には出さない）。 */
  assetId: string;
};

/** conflict: 同じキーで内容が違う要求か、そのキーで作ったページがゴミ箱にある（キーは使えない）。 */
export type StartAudioRecordingResult = StartedAudioRecording | { status: "conflict" };

export type CompleteAudioUploadResult = { status: "ok"; recording: Recording } | { status: "size_mismatch" };

/** 完了の段 2b・文字起こしが保存先の object を引くための、音声の資産の情報。 */
export type AudioInfo = {
  assetId: string;
  objectPath: string;
  status: RecordingAudioStatus;
  bytes: number;
  contentType: string;
  sha256: string;
  expiresAt: string | null;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && isPageId(value);
}

function startProblem(input: StartAudioRecordingInput): string | null {
  if (!isUuid(input.assetId)) return "asset";
  if (input.lang !== "ja" && input.lang !== "en") return "lang";
  if (typeof input.title !== "string" || !isStorableText(input.title) || charCount(input.title) > PAGE_TITLE_MAX_CHARS) return "title";
  const name = input.sourceName;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    /[/\\]/.test(name) ||
    CONTROL_CHARACTERS.test(name) ||
    !isStorableText(name) ||
    charCount(name) > RECORDING_SOURCE_NAME_MAX_CHARS
  ) {
    return "source_name";
  }
  if (typeof input.contentType !== "string" || input.contentType.length > CONTENT_TYPE_MAX_CHARS || !CONTENT_TYPE.test(input.contentType)) {
    return "content_type";
  }
  if (typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) || input.bytes < 1) return "bytes";
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return "sha256";
  const duration = input.durationSec;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) return "duration";
  if (input.uploadKey !== null && !isUuid(input.uploadKey)) return "upload_key";
  if (typeof input.requestHash !== "string" || !SHA256.test(input.requestHash)) return "request_hash";
  if (typeof input.retentionDays !== "number" || !Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1) return "retention";
  return null;
}

type PageRow = { id: string; kind: "rec"; title: string; lang: PageLang; created_at: Date; updated_at: Date };

function toPage(row: PageRow): RecordingPage {
  return {
    id: row.id,
    kind: "rec",
    title: row.title,
    lang: row.lang,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// $1 page id / $2 owner / $3 asset id / $4 bucket_path / $5 bytes / $6 sha256（申告）/ $7 content type（申告）
const INSERT_ASSET_SQL = `
INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type)
VALUES ($3, $2, $1, 'audio', $4, $5, $6, $7)`;

// 録音の作成時刻・期限はページと同じ行から取る（JS の Date を経由しない）。段落は空（文字起こしは段 2b）。
// 期限は日数 × 24 時間（days の interval は session の時間帯の夏時間で 1 時間ずれるので使わない）。
// $1 page id / $2 owner / $3 language / $4 duration / $5 source name / $6 asset id / $7 upload key / $8 request hash / $9 保持の日数
const INSERT_AUDIO_RECORDING_SQL = `
INSERT INTO page_recordings AS r
  (page_id, owner, source, language, engine, duration_sec, source_name, source_sha256, segments, speaker_names,
   audio_asset, audio_status, audio_expires_at, audio_upload_key, audio_request_hash, created_at, updated_at)
SELECT p.id, p.owner, 'audio', $3::text, NULL, $4::numeric, $5::text, NULL, '[]'::jsonb, '{}'::jsonb,
       $6::uuid, 'uploading', p.created_at + make_interval(hours => $9::int * 24), $7::uuid, $8::text, p.created_at, p.created_at
  FROM pages AS p
 WHERE p.id = $1 AND p.owner = $2
RETURNING ${RECORDING_COLUMNS}`;

type KeyRow = RecordingRow & {
  page_id: string;
  title: string;
  lang: PageLang;
  page_created_at: Date;
  page_updated_at: Date;
  deleted: boolean;
  audio_asset: string;
  audio_request_hash: string | null;
};

// 同じ owner・同じ冪等キーで作った録音（ゴミ箱のページも含めて引き、呼び出し側で conflict にする）。$1 owner / $2 key。
const FIND_BY_KEY_SQL = `
SELECT ${RECORDING_COLUMNS}, r.page_id, r.audio_asset, r.audio_request_hash,
       p.title, p.lang, p.created_at AS page_created_at, p.updated_at AS page_updated_at, p.deleted_at IS NOT NULL AS deleted
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
 WHERE r.owner = $1 AND r.audio_upload_key = $2`;

const UPLOAD_KEY_CONSTRAINT = "page_recordings_audio_upload_key_key";

function isUploadKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === UPLOAD_KEY_CONSTRAINT;
}

async function findByKey(db: Pick<PoolClient, "query">, owner: OwnerId, key: string, requestHash: string): Promise<StartAudioRecordingResult | null> {
  const result = await db.query<KeyRow>(FIND_BY_KEY_SQL, [owner, key]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.deleted || row.audio_request_hash !== requestHash) return { status: "conflict" };
  return {
    status: "existing",
    page: toPage({ id: row.page_id, kind: "rec", title: row.title, lang: row.lang, created_at: row.page_created_at, updated_at: row.page_updated_at }),
    recording: toRecording(row),
    assetId: row.audio_asset,
  };
}

/**
 * 音声の録音を始める: pages（kind = 'rec'・本文は空）・assets（kind = 'audio'）・page_recordings（source = 'audio'・段落は空・
 * 状態 uploading・期限 = 作成の時刻 + retentionDays 日）を 1 つの transaction で入れる（途中で失敗したらどれも残らない）。
 * 冪等: 同じ owner・同じ uploadKey の録音が既にあれば、要求の内容（requestHash）が同じなら何も書かずにそれを返し（existing）、
 * 違えば conflict。同じキーの要求が並んでも、入るのは 1 つだけ（UNIQUE で止まった側は先に入った方を引いて返す）。
 * 形が規則に合わなければ InvalidRecordingError（何も書かない）。
 */
export async function startAudioRecording(pool: Connectable, owner: OwnerId, input: StartAudioRecordingInput): Promise<StartAudioRecordingResult> {
  assertOwner(owner);
  const problem = startProblem(input);
  if (problem) throw new InvalidRecordingError(problem);
  const assetId = input.assetId.toLowerCase();
  const objectPath = audioObjectPath(assetId);

  const client = await pool.connect();
  try {
    if (input.uploadKey !== null) {
      const existing = await findByKey(client, owner, input.uploadKey, input.requestHash);
      if (existing) return existing;
    }
    await client.query("BEGIN");
    try {
      const pageResult = await client.query<PageRow>(INSERT_PAGE_SQL, [owner, input.title, input.lang]);
      const page = pageResult.rows[0];
      if (!page) throw new Error("editor-store: insert returned no page");
      await client.query(INSERT_ASSET_SQL, [page.id, owner, assetId, objectPath, input.bytes, input.sha256, input.contentType]);
      const recordingResult = await client.query<RecordingRow>(INSERT_AUDIO_RECORDING_SQL, [
        page.id,
        owner,
        input.lang,
        input.durationSec,
        input.sourceName,
        assetId,
        input.uploadKey,
        input.requestHash,
        input.retentionDays,
      ]);
      const recording = recordingResult.rows[0];
      if (!recording) throw new Error("editor-store: insert returned no recording");
      await client.query("COMMIT");
      return { status: "created", page: toPage(page), recording: toRecording(recording), assetId };
    } catch (error) {
      await rollback(client);
      // 同じキーの要求が並んで、先に入った方がある: その録音を返す（内容が違えば conflict）
      if (input.uploadKey !== null && isUploadKeyConflict(error)) {
        const existing = await findByKey(client, owner, input.uploadKey, input.requestHash);
        if (existing) return existing;
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

type CompleteRow = { audio_status: "none" | RecordingAudioStatus; bytes: string };

// 本人の・ゴミ箱でないページの、音声のある録音の行を押さえる。$1 owner / $2 page id。
const LOCK_AUDIO_SQL = `
SELECT r.audio_status, a.bytes::text AS bytes
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
  JOIN assets AS a ON a.owner = r.owner AND a.id = r.audio_asset
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL AND r.audio_status <> 'none'
   FOR UPDATE OF r`;

// revision は文字起こしの編集の番号なので進めない（音声の状態の変化で編集の競合を起こさない）
const MARK_UPLOADED_SQL = `
UPDATE page_recordings AS r
   SET audio_status = 'uploaded',
       updated_at = GREATEST(clock_timestamp(), r.updated_at)
 WHERE r.owner = $1 AND r.page_id = $2 AND r.audio_status = 'uploading'
RETURNING ${RECORDING_COLUMNS}`;

/**
 * アップロードの完了。行を FOR UPDATE で押さえてから状態を見るので、並んで呼ばれても更新は 1 回だけ。
 * - 本人の・ゴミ箱でないページの音声が無い（別の人・存在しない・不正な id・削除済み・音声の無い録音）: null
 * - uploaded: 何も書かずにそのまま成功（冪等）
 * - uploading で stored.sizeBytes が申告の bytes と同じ: uploaded にして、ページの更新時刻も進める
 * - uploading で大きさが違う: `{ status: "size_mismatch" }`（何も書かない）
 * stored は保存先で確かめた object の大きさ（呼び出し側が保存先に問い合わせる）。
 */
export async function completeAudioUpload(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  stored: { sizeBytes: number },
): Promise<CompleteAudioUploadResult | null> {
  assertOwner(owner);
  if (!stored || typeof stored.sizeBytes !== "number" || !Number.isSafeInteger(stored.sizeBytes) || stored.sizeBytes < 0) {
    throw new TypeError("editor-store: stored size must be a non-negative integer");
  }
  if (!isPageId(pageId)) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const locked = await client.query<CompleteRow>(LOCK_AUDIO_SQL, [owner, pageId]);
      const row = locked.rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      if (row.audio_status === "uploaded") {
        const current = await client.query<RecordingRow>(GET_SQL, [owner, pageId]);
        await rollback(client);
        const recording = current.rows[0];
        return recording ? { status: "ok", recording: toRecording(recording) } : null;
      }
      if (Number(row.bytes) !== stored.sizeBytes) {
        await rollback(client);
        return { status: "size_mismatch" };
      }
      const updated = await client.query<RecordingRow>(MARK_UPLOADED_SQL, [owner, pageId]);
      const saved = updated.rows[0];
      if (!saved) throw new Error("editor-store: update returned no recording");
      await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
      await client.query("COMMIT");
      return { status: "ok", recording: toRecording(saved) };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

type AudioInfoRow = {
  asset_id: string;
  bucket_path: string;
  audio_status: RecordingAudioStatus;
  bytes: string;
  content_type: string;
  sha256: string;
  audio_expires_at: Date | null;
};

// $1 owner / $2 page id。
const AUDIO_INFO_SQL = `
SELECT a.id AS asset_id, a.bucket_path, r.audio_status, a.bytes::text AS bytes, a.content_type, a.sha256, r.audio_expires_at
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
  JOIN assets AS a ON a.owner = r.owner AND a.id = r.audio_asset
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL AND r.audio_status <> 'none'`;

/** 本人の・ゴミ箱でないページの音声の資産。無ければ null（別の人・存在しない・不正な id・削除済み・音声の無いページ）。 */
export async function audioInfo(db: Queryable, owner: OwnerId, pageId: string): Promise<AudioInfo | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const result = await db.query<AudioInfoRow>(AUDIO_INFO_SQL, [owner, pageId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      assetId: row.asset_id,
      objectPath: row.bucket_path,
      status: row.audio_status,
      bytes: Number(row.bytes),
      contentType: row.content_type,
      sha256: row.sha256,
      expiresAt: row.audio_expires_at ? row.audio_expires_at.toISOString() : null,
    };
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}
