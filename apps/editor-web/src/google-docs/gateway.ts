/**
 * editor から見た Google ドキュメント書き出しの口（port）。実装は src/google-docs/niho.ts（NIHO の API）。
 *
 * 旧 NIHO docs の Mac アプリ（`apps/docs/src-tauri/src/google_docs.rs`）が使っていた契約をそのまま使う。
 * 本人の資格情報（NIHO の ID token）は呼び出しのたびに渡し、**この層の外（結果・例外・ログ）には出さない**。
 * 将来 editor が自分で Google を呼ぶことになったら、この口の実装を 1 本足す（設計 §7）。
 */

/** 本人の Google ドキュメント接続。token・credential は持たない。 */
export type GoogleDocsConnection = {
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  connectedEmail: string | null;
  reason: string | null;
};

/** 書き出しの受付の結果。`url` は `documentId` から組み立てたもの（API が返した URL は使わない）。 */
export type GoogleDocsExport =
  | { exportId: string; status: "completed"; documentId: string; url: string }
  | { exportId: string; status: "pending"; retryable: boolean };

export type GoogleDocsExportRequest = { exportId: string; title: string; markdown: string };

/**
 * 失敗の短い code（旧 Mac アプリの `api_error` と同じ分け方）。
 *
 * - `signed_out`: NIHO へのログインをやり直す。
 * - `app_not_allowed`: niho-app が editor からの呼び出しを許していない（API の `niho_docs_app_required`）。
 * - `temporarily_unavailable`: 一時停止・混み合い・上流の 5xx・API 側の設定待ち。
 * - `drive_not_connected` / `drive_reconnect_required`: Google へつなぎ直す。
 * - `drive_connection_changed`: 接続先の Google アカウントが変わった（前の受付はこのアカウントでは確認できない）。
 * - `export_payload_conflict`: 同じ `exportId` で中身が変わった（新しい書き出しとしてやり直す）。
 * - `export_not_found`: その `exportId` はまだ受け付けられていない。
 * - `export_result_unknown`: 送ったが結果が分からない（**書き出しの POST だけ**）。同じ `exportId` で確かめてから再試行する。
 * - `invalid_export`: 題名・本文が受け付けられない（長すぎる・空）。
 * - `invalid_response`: API の応答が契約の形でない（検証に通らない URL・`documentId` を含む）。
 * - `google_docs_failed`: そのほかの失敗。
 */
export type GoogleDocsFailureCode =
  | "signed_out"
  | "app_not_allowed"
  | "temporarily_unavailable"
  | "drive_not_connected"
  | "drive_reconnect_required"
  | "drive_connection_changed"
  | "export_payload_conflict"
  | "export_not_found"
  | "export_result_unknown"
  | "invalid_export"
  | "invalid_response"
  | "google_docs_failed";

/** 失敗。持つのは code だけ（応答の本文・token・題名・本文は持たない）。 */
export class GoogleDocsError extends Error {
  readonly code: GoogleDocsFailureCode;

  constructor(code: GoogleDocsFailureCode) {
    super(`google docs request failed: ${code}`);
    this.name = "GoogleDocsError";
    this.code = code;
  }
}

/** 本人の資格情報。値は呼ぶ瞬間だけ関数から取る（渡した object を文字列にしても出ない）。 */
export type GoogleDocsCredential = { readonly idToken: () => string };

export type GoogleDocsGateway = {
  connection(credential: GoogleDocsCredential): Promise<GoogleDocsConnection>;
  /** Google の同意へ送る URL（host と path を確かめたもの）。 */
  connect(credential: GoogleDocsCredential): Promise<string>;
  disconnect(credential: GoogleDocsCredential): Promise<GoogleDocsConnection>;
  /** 同じ `exportId` の呼び出しは、同じ内容の再試行だけに使う。 */
  export(credential: GoogleDocsCredential, request: GoogleDocsExportRequest): Promise<GoogleDocsExport>;
  exportStatus(credential: GoogleDocsCredential, exportId: string): Promise<GoogleDocsExport>;
};

/** 題名の上限（UTF-16。旧 Mac アプリと同じ）。 */
export const MAX_TITLE_UNITS = 200;
/** 本文の上限（UTF-16 の長さと、UTF-8 のバイト数。旧 Mac アプリと同じ）。 */
export const MAX_MARKDOWN_UNITS = 1_000_000;
export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

const UUID_LOWERCASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{10,256}$/;

/** 小文字の UUID だけ（旧 Mac アプリの `uuid_is_lowercase`）。 */
export function isExportId(value: unknown): value is string {
  return typeof value === "string" && UUID_LOWERCASE.test(value);
}

/** `documentId` の形（旧 Mac アプリの `document_id_is_valid`）。 */
export function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_ID.test(value);
}

/** 画面に出す URL は、確かめた `documentId` からこちらで組み立てる。 */
export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

function utf16Length(value: string): number {
  return value.length;
}

/**
 * ページの題名を、API が受け取れる形にする。
 *
 * **ページの題名は 500 文字まで入る**（`src/lib/page-limits.ts` の `MAX_TITLE_CHARS`）のに、API の上限は 200（UTF-16）なので、
 * 長い題名は**断らずに切る**（書き出せないほうが困る）。切るのは code point の境目で、サロゲートペアを割らない。
 * 前後の空白は落とし、空（空白だけ）の題名は「無題」にする（画面の無題の表示と同じ）。
 */
export function googleDocTitle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return UNTITLED;
  if (utf16Length(trimmed) <= MAX_TITLE_UNITS) return trimmed;
  let kept = "";
  for (const character of trimmed) {
    if (kept.length + character.length > MAX_TITLE_UNITS) break;
    kept += character;
  }
  // 1 文字目が上限を超えることは無いが、後ろの守り
  return kept.trimEnd() || UNTITLED;
}

/** 題名の無いページ（画面の表示と同じ言葉）。 */
export const UNTITLED = "無題";

/** 題名と本文が送れる形か（旧 Mac アプリの `docs_drive_export` と同じ判定）。 */
export function checkExportRequest(request: GoogleDocsExportRequest): "ok" | "invalid_export" {
  if (!isExportId(request.exportId)) return "invalid_export";
  const title = request.title.trim();
  if (title === "" || utf16Length(title) > MAX_TITLE_UNITS) return "invalid_export";
  const { markdown } = request;
  if (markdown === "" || utf16Length(markdown) > MAX_MARKDOWN_UNITS) return "invalid_export";
  if (new TextEncoder().encode(markdown).byteLength > MAX_MARKDOWN_BYTES) return "invalid_export";
  return "ok";
}
