import {
  SHA256_PATTERN,
  TIMESTAMP_PATTERN,
  isFaceDest,
  type FaceDest,
  type MovedTo,
  type PublicationRange,
  type PublishedDoc,
} from "@niho/editor-publish-contract";

/**
 * 公開 API v1（#40。docs/security/editor-publish-api-v1.md）の handler が読むデータの port。
 * DB の形に近い最小限の問い合わせだけを持ち、認可（どの資格がどの handle を読めるか）・形の検査・応答の組み立ては handler が行う。
 * 実装は段 2 で packages/editor-store のクエリがする（テストはメモリの実装。src/public-api/testing/world-source.ts）。
 *
 * 時刻の比べ方は全て `now`（handler の時計。1 つの要求の中では同じ値）で行う:
 * - 失効・解除・公開をやめた時刻は `<= now` で効いている（未来の時刻はまだ効いていない）。
 * - 鍵・token の平文は渡さない。渡すのは SHA-256（小文字の hex）だけ。
 */

/** 公開した時点の不変の公開版（PublishedDoc から range を除いたもの）。余分な field（fingerprint など）は handler が落とす。 */
export type PublishedSnapshot = Omit<PublishedDoc, "range">;

/** 公開版 1 件。range は公開の行が持ついまの値（公開版の中の値ではない）。 */
export interface PublishedRow {
  readonly range: PublicationRange;
  readonly snapshot: PublishedSnapshot;
}

/** 一覧の keyset の位置（前のページの最後の項目の updatedAt と id）。 */
export interface ListPosition {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ListPublishedQuery {
  readonly handle: string;
  /** 範囲が `unlisted` のものも載せる（面が `include=unlisted` を付けたときだけ true）。 */
  readonly includeUnlisted: boolean;
  /** この位置より後ろ（updatedAt が古い、同時刻なら id が大きい）だけ。null は先頭から。 */
  readonly after: ListPosition | null;
  /** 返す最大の件数（handler は次のページの有無を知るため、ページの件数 + 1 を頼む）。 */
  readonly limit: number;
  readonly now: string;
}

/**
 * handle × pageId の公開版。
 * - published: この handle に公開中。
 * - left: この handle で公開をやめた、または移動で離れた。面 → 別の面の移動で、移動先に公開中なら movedTo（それ以外は null）。
 * - none: この handle に公開したことがない（下書き・自分だけ・存在しない・他の発信先）。
 */
export type PublishedLookup =
  | { readonly state: "published"; readonly row: PublishedRow }
  | { readonly state: "left"; readonly range: PublicationRange; readonly movedTo: MovedTo | null }
  | { readonly state: "none" };

/** プレビュー token の拘束。期限・15 分の上限・資格との突き合わせは handler が行う。 */
export interface PreviewBinding {
  readonly pageId: string;
  /** 面は `exp` / `niho`、本人のサイトは接続の handle。 */
  readonly handle: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** 下書きの内容を公開版の形にしたもの（公開の時点で決まる id・dest・版・時刻・Markdown・contractVersion を除く）。 */
export type DraftContent = Omit<PublishedDoc, "id" | "dest" | "version" | "publishedAt" | "updatedAt" | "markdown" | "contractVersion">;

/** プレビューで読む現在の下書き。 */
export interface PreviewDraft {
  /** 下書きの版（PreviewDoc の version）。 */
  readonly revision: number;
  /** 下書きの保存時刻（PreviewDoc の publishedAt・updatedAt）。 */
  readonly savedAt: string;
  readonly content: DraftContent;
}

export interface PublicApiSource {
  /** 鍵の SHA-256 → その鍵の接続の handle。未知・失効した鍵・解除した接続は null（区別しない）。 */
  siteHandleByKeyHash(sha256: string, now: string): Promise<string | null>;
  /**
   * handle の公開中の一覧。snapshot の dest が handle の発信先のもの・公開をやめていないもの・範囲が live（includeUnlisted なら unlisted も）だけ。
   * 並びは updatedAt の新しい順、同時刻は id の昇順。
   */
  listPublished(query: ListPublishedQuery): Promise<readonly PublishedRow[]>;
  /** handle × pageId の公開版（snapshot の dest が handle の発信先のものだけを見る）。 */
  getPublished(handle: string, pageId: string, now: string): Promise<PublishedLookup>;
  /** プレビュー token の SHA-256 → 拘束。未知は null。 */
  previewTokenByHash(sha256: string): Promise<PreviewBinding | null>;
  /**
   * プレビュー用の現在の下書き（packages/editor-publish の buildSnapshot で、その handle の公開の設定と現在の下書きから組む）。
   * ページが無い・ゴミ箱・公開の形に組めない（未確認の画像など）ときは null。
   */
  previewDraft(pageId: string, handle: string): Promise<PreviewDraft | null>;
}

// --- 面（NIHO の発信先）のサービス間の資格 ------------------------------------------------------

/** 面のサービス間の資格の SHA-256 → audience（`exp` / `niho`）。期限切れ・未知は null。 */
export interface FaceCredentialSource {
  audienceByHash(sha256: string, now: string): FaceDest | null;
}

export const FACE_CREDENTIALS_ENV = "EDITOR_FACE_CREDENTIALS";

export interface FaceCredentialEntry {
  readonly audience: FaceDest;
  readonly sha256: string;
  readonly expiresAt: string;
}

const ENTRY_KEYS = ["audience", "expiresAt", "sha256"];

/**
 * `EDITOR_FACE_CREDENTIALS`（JSON の配列 `[{ "audience": "exp"|"niho", "sha256": "<hex>", "expiresAt": "<ISO>" }]`）を読む。
 * 未設定・空は "unset"。1 つでも形が違う（未知の field・型・重複した sha256・JSON でない）なら "invalid"（全体を捨てる）。
 *
 * これは署名つきのサービス間 token の契約（audience と期限を token 自身が持ち、署名を検証する）ができるまでの暫定の方式。
 * token の平文は置かず、SHA-256 と audience と期限だけを secret の設定に置く。失効は設定から外して再起動する。
 */
export function parseFaceCredentials(raw: string | undefined): readonly FaceCredentialEntry[] | "unset" | "invalid" {
  if (raw === undefined || raw.trim() === "") return "unset";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (!Array.isArray(value)) return "invalid";
  const entries: FaceCredentialEntry[] = [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "invalid";
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join() !== ENTRY_KEYS.join()) return "invalid";
    const { audience, sha256, expiresAt } = record;
    if (!isFaceDest(audience)) return "invalid";
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256) || seen.has(sha256)) return "invalid";
    if (typeof expiresAt !== "string" || !TIMESTAMP_PATTERN.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) return "invalid";
    seen.add(sha256);
    entries.push({ audience, sha256, expiresAt });
  }
  return entries;
}

/** 設定の項目から引く。期限は `expiresAt > now` の間だけ有効。 */
export function faceCredentialSource(entries: readonly FaceCredentialEntry[]): FaceCredentialSource {
  const byHash = new Map(entries.map((entry) => [entry.sha256, entry] as const));
  return {
    audienceByHash(sha256, now) {
      const entry = byHash.get(sha256);
      return entry && Date.parse(entry.expiresAt) > Date.parse(now) ? entry.audience : null;
    },
  };
}

/** 誰も通さない（未設定・不正な設定のとき）。 */
export const NO_FACE_CREDENTIALS: FaceCredentialSource = { audienceByHash: () => null };

let cachedRaw: string | undefined;
let cachedSource: FaceCredentialSource = NO_FACE_CREDENTIALS;
let cachedOnce = false;

/**
 * env の `EDITOR_FACE_CREDENTIALS` から（値が変わらなければ読み直さない）。未設定・不正なら誰も通さない（fail closed）。
 * 不正なときのログは「不正」の一言だけで、値・位置・理由は出さない。
 */
export function faceCredentialsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): FaceCredentialSource {
  const raw = env[FACE_CREDENTIALS_ENV];
  if (cachedOnce && raw === cachedRaw) return cachedSource;
  const parsed = parseFaceCredentials(raw);
  if (parsed === "invalid") console.error(`editor-web: ${FACE_CREDENTIALS_ENV} is invalid`);
  cachedRaw = raw;
  cachedOnce = true;
  cachedSource = parsed === "unset" || parsed === "invalid" ? NO_FACE_CREDENTIALS : faceCredentialSource(parsed);
  return cachedSource;
}
