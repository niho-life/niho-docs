/**
 * 資産の保存先（private bucket）の接続口。音声（#36）と画像（#33）が同じ口を使う。
 *
 * アップロードでサーバーは中身を受け取らない: 「開始」で保存先のアップロードのセッションを作ってブラウザに渡し
 * （ブラウザが保存先へ直接 PUT する）、「完了」で object の大きさを確かめるだけ。削除と上書きはしない
 * （実行 ID の権限が作成と閲覧だけ。期限での削除は bucket の規則）。
 *
 * 読み取り（readObject）だけは中身を通す: 画像（#33）はサーバーが中継し（`/api/assets/{id}`・共有は `/s/{token}/a/{id}`）、
 * 署名付き GET URL をブラウザへ渡さない。
 *
 * 秘密の扱い: ticket の url は持っている人がアップロードできる値（bearer）。応答で本人に渡すだけで、ログ・エラー・DB に書かない。
 * StorageError のメッセージには bucket 名・object の場所・token・URL を入れない（固定の文だけ）。
 */

/** ブラウザが保存先へ直接アップロードするための情報。 */
export type UploadTicket = {
  /** アップロード先（持っている人が PUT できる。ログに出さない）。 */
  url: string;
  method: "PUT";
  /** PUT に付ける header。 */
  headers: Record<string, string>;
  /** url が使えなくなる見込みの時刻（ISO 8601）。 */
  expiresAt: string;
};

export type StartUploadInput = {
  /** bucket の中の場所（`audio/{asset id}` など。OBJECT_PATH_PATTERN の形だけ）。 */
  objectPath: string;
  contentType: string;
  /** アップロードする大きさ（バイト。保存先はこの大きさを超える PUT を断る）。 */
  sizeBytes: number;
  /** editor の画面の origin（保存先の CORS がこの origin からの PUT を通す）。分からなければ null。 */
  origin: string | null;
};

/** 保存先にある object（無ければ null）。 */
export type StoredObject = { sizeBytes: number; contentType: string | null };

/** 保存先から読み出した object（中身は 1 回だけ読める流れ）。 */
export type ReadObject = { body: ReadableStream<Uint8Array>; contentType: string | null; sizeBytes: number };

export interface ObjectStorage {
  readonly kind: "fake" | "gcs";
  /** アップロードのセッションを作る。同じ場所に object が既にあれば上書きしない（保存先が断る）。 */
  startUpload(input: StartUploadInput): Promise<UploadTicket>;
  /** object の大きさと種類。無ければ null。 */
  stat(objectPath: string): Promise<StoredObject | null>;
  /**
   * object の中身を読む（画像の中継。無ければ null）。
   * 応答の流れをそのまま返すので、呼び出し側は返した body を読み切るか cancel する。
   */
  readObject(objectPath: string): Promise<ReadObject | null>;
}

/** unavailable: 保存先に届かない・権限・一時的な失敗 / rejected: 保存先が要求を断った（形・既にある・大きさ）。 */
export type StorageErrorCode = "unavailable" | "rejected";

const MESSAGES: Record<StorageErrorCode, string> = {
  unavailable: "editor-web: object storage is unavailable",
  rejected: "editor-web: object storage rejected the request",
};

/** 保存先の失敗。メッセージは code ごとの固定の文だけ（bucket 名・場所・token・URL を含めない）。 */
export class StorageError extends Error {
  override readonly name = "StorageError";
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/**
 * object の場所の形: `{種類}/{名前}`（種類は小文字の英字・数字・`-`、名前は英数字・`_`・`-`。`.` と `/` を含まない＝親へ上がれない）。
 * 音声は `audio/{asset id}`、画像は `image/{asset id}`。
 */
export const OBJECT_PATH_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isObjectPath(value: unknown): value is string {
  return typeof value === "string" && OBJECT_PATH_PATTERN.test(value);
}
