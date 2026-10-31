/**
 * 資産の保存先の方式（`EDITOR_STORAGE`）と bucket（`EDITOR_ASSETS_BUCKET`）。要求のたびに読む（import 時・`next build` 時に固めない）。
 *
 * - `fake`: メモリの偽物（開発と CI だけ）。`NODE_ENV=production` では受け付けない（起動を止める。偽物の保存先に利用者の音声を預けない）。
 * - `gcs`: Google Cloud Storage（src/storage/gcs.ts）。`EDITOR_ASSETS_BUCKET` が必須で、bucket 名の規則に合わなければ起動を止める。
 * - `off`: 使わない（音声の API は 503 `storage_unavailable`）。
 * - 未設定・空: 本番は `off`、それ以外は `fake`。
 * - それ以外の値: 誤り（起動を止める）。
 *
 * 本番の守りは 2 か所: 起動時の検査（src/startup-check.ts。src/instrumentation.ts から。誤りなら process を終える）と、
 * 要求ごとの解決（src/storage/runtime.ts の getStorage。誤りなら保存先なし＝503）。起動の入口（scripts/server-entry.mjs）は
 * 認証だけを見る（入口から読ませるには Dockerfile にこのファイルを足す必要がある。AI の設定と同じく、入口と Dockerfile は変えない）。
 * エラーのメッセージには値（bucket 名）を入れない。
 */

export const STORAGE_MODES = ["fake", "gcs", "off"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export type StorageEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_STORAGE?: string | undefined;
  readonly EDITOR_ASSETS_BUCKET?: string | undefined;
};

export type StorageConfig = { kind: "off" } | { kind: "fake" } | { kind: "gcs"; bucket: string };

export class StorageConfigError extends Error {
  override readonly name = "StorageConfigError";
}

function isStorageMode(value: string): value is StorageMode {
  return (STORAGE_MODES as readonly string[]).includes(value);
}

const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * GCS の bucket 名の規則（https://cloud.google.com/storage/docs/buckets#naming）: 小文字の英字・数字・`-`・`_`・`.`、
 * 英数字で始まり英数字で終わる、3〜63 文字（`.` を含むときは全体で 222 文字まで、`.` で区切った各部分は 63 文字まで）、
 * IP アドレスの形でない、`goog` で始まらない、`google` を含まない。
 */
export function isBucketName(value: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(value)) return false;
  if (value.includes("..") || value.includes(".-") || value.includes("-.")) return false;
  const parts = value.split(".");
  if (parts.length === 1) {
    if (value.length < 3 || value.length > 63) return false;
  } else {
    if (value.length > 222 || parts.some((part) => part.length === 0 || part.length > 63)) return false;
  }
  if (IPV4_LIKE.test(value)) return false;
  if (value.startsWith("goog") || value.includes("google")) return false;
  return true;
}

/** 保存先の方式を決める。誤りは StorageConfigError（値を含めない）。 */
export function resolveStorageConfig(env: StorageEnv): StorageConfig {
  const raw = env.EDITOR_STORAGE?.trim() ?? "";
  if (raw !== "" && !isStorageMode(raw)) throw new StorageConfigError("EDITOR_STORAGE must be one of: fake, gcs, off");
  const production = env.NODE_ENV === "production";
  if (raw === "fake" && production) {
    throw new StorageConfigError("EDITOR_STORAGE=fake is not allowed when NODE_ENV=production (fake storage is for development and CI only)");
  }
  if (raw === "gcs") {
    const bucket = env.EDITOR_ASSETS_BUCKET?.trim() ?? "";
    if (bucket === "") throw new StorageConfigError("EDITOR_ASSETS_BUCKET is required when EDITOR_STORAGE=gcs");
    if (!isBucketName(bucket)) throw new StorageConfigError("EDITOR_ASSETS_BUCKET is not a valid bucket name");
    return { kind: "gcs", bucket };
  }
  if (raw === "off") return { kind: "off" };
  if (raw === "fake") return { kind: "fake" };
  return production ? { kind: "off" } : { kind: "fake" };
}
