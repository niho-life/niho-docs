import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

/**
 * Google の ID トークン（Cloud Tasks・Cloud Scheduler が付ける OIDC トークン）の検証。worker の route（#37）が使う。
 * サービスは誰でも呼べる設定なので、route が自分で検証する。依存を足さず `node:crypto` と `fetch` だけで行う。
 *
 * - アルゴリズムは RS256 だけ（header の `alg` で検証の方式を選ばない。`none`・`HS256` などの混同を受けない）。
 * - 鍵は固定の URL の JWKS から `kid` で引く（header の `jku`・`jwk`・`x5u` は読まない）。
 * - 失敗は短い code だけを返す（トークン・クレームの値は結果にもログにも出さない）。
 */

/** Google の公開鍵（JWKS）。この URL だけを読む。 */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** 時計のずれの許容（秒）。`exp`・`iat`・`nbf` に使う。 */
export const CLOCK_SKEW_SECONDS = 60;
/** トークンの長さの上限（Google の ID トークンは 1 KiB 前後）。 */
export const MAX_TOKEN_LENGTH = 4096;

const JWKS_MIN_AGE_SECONDS = 60;
const JWKS_MAX_AGE_SECONDS = 3600;
/** JWKS を取り直す間隔の下限（未知の `kid`・期限切れ・取得の失敗のどれでも）。 */
export const JWKS_REFETCH_INTERVAL_MS = 30_000;
/** 取得に失敗し続けるとき、期限の切れた鍵で続けてよい長さ。過ぎたら拒否する。 */
export const JWKS_STALE_LIMIT_MS = 24 * 60 * 60 * 1000;
const JWKS_MAX_CHARS = 64 * 1024;
const JWKS_TIMEOUT_MS = 5_000;
const MIN_RSA_BITS = 2048;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type OidcFailureCode =
  | "token_too_large"
  | "malformed"
  | "unsupported_alg"
  | "missing_kid"
  | "unknown_kid"
  | "jwks_unavailable"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "invalid_claims"
  | "expired"
  | "not_yet_valid"
  | "issued_in_future"
  | "bad_email"
  | "email_unverified"
  | "missing_subject";

/** 通ったかどうかと、通らなかった理由の code だけ（クレームの値は返さない）。 */
export type OidcVerifyResult = { ok: true } | { ok: false; code: OidcFailureCode };

export type VerifyGoogleOidcOptions = {
  /** 期待する `aud`（完全一致）。 */
  audience: string;
  /** 許可する 1 つのサービスアカウントのメール（`email` と完全一致、かつ `email_verified === true`）。 */
  allowedEmail: string;
  /** JWKS の取得（テストでは差し替える）。キャッシュはこの関数ごとに持つ。 */
  fetch?: typeof fetch;
  /** 今の時刻（ms）。 */
  now?: () => number;
};

type JwksEntry = { keys: ReadonlyMap<string, KeyObject>; expiresAt: number };
type JwksState = { entry?: JwksEntry; lastAttemptAt?: number; inflight?: Promise<void> };

// キャッシュは既定の fetch で 1 つ（global の fetch が差し替えられても共有する）と、注入した fetch ごとに 1 つ（テストは差し替えるたびに空から）
const defaultJwksState: JwksState = {};
const injectedJwksStates = new WeakMap<typeof fetch, JwksState>();

function jwksStateFor(fetchFn: typeof fetch | undefined): JwksState {
  if (!fetchFn) return defaultJwksState;
  let state = injectedJwksStates.get(fetchFn);
  if (!state) {
    state = {};
    injectedJwksStates.set(fetchFn, state);
  }
  return state;
}

function fail(code: OidcFailureCode): OidcVerifyResult {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64URL（padding なし）の正規の形だけを bytes にする（同じ bytes の別の書き方・不正な文字は null）。 */
function decodeBase64Url(part: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(part) || part.length % 4 === 1) return null;
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

function decodeJsonObject(part: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** `Cache-Control` の `max-age`（秒）を 60 秒〜1 時間に収める。無ければ下限。 */
function jwksMaxAgeSeconds(header: string | null): number {
  const match = header ? /(?:^|[\s,])max-age\s*=\s*"?(\d{1,10})"?/i.exec(header) : null;
  const seconds = match ? Number(match[1]) : 0;
  return Math.min(Math.max(seconds, JWKS_MIN_AGE_SECONDS), JWKS_MAX_AGE_SECONDS);
}

/** JWKS の 1 つの鍵（RS256 の署名用の RSA で 2048 bit 以上だけ。それ以外は読み飛ばす）。 */
function toPublicKey(jwk: unknown): [string, KeyObject] | null {
  if (!isRecord(jwk)) return null;
  const { kty, kid, n, e, alg, use } = jwk;
  if (kty !== "RSA" || typeof kid !== "string" || !KID_PATTERN.test(kid) || typeof n !== "string" || typeof e !== "string") return null;
  if (alg !== undefined && alg !== "RS256") return null;
  if (use !== undefined && use !== "sig") return null;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
    return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS ? [kid, key] : null;
  } catch {
    return null;
  }
}

async function loadJwks(fetchFn: typeof fetch, requestedAt: number): Promise<JwksEntry> {
  const response = await fetchFn(GOOGLE_JWKS_URL, {
    headers: { accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("jwks_status");
  }
  const text = await response.text();
  if (text.length > JWKS_MAX_CHARS) throw new Error("jwks_too_large");
  const body: unknown = JSON.parse(text);
  const keys = new Map<string, KeyObject>();
  if (isRecord(body) && Array.isArray(body.keys)) {
    for (const jwk of body.keys) {
      const entry = toPublicKey(jwk);
      if (entry) keys.set(entry[0], entry[1]);
    }
  }
  if (keys.size === 0) throw new Error("jwks_empty");
  return { keys, expiresAt: requestedAt + jwksMaxAgeSeconds(response.headers.get("cache-control")) * 1000 };
}

/**
 * `kid` の公開鍵。キャッシュが新しく `kid` があればそれ。無い・期限切れ・未知の `kid` なら 1 回だけ取り直す
 * （30 秒に 1 回まで。並行の要求は同じ取得を待つ）。取得に失敗したら、古いキャッシュ（期限切れから 24 時間まで）で続ける。
 */
async function findKey(injected: typeof fetch | undefined, kid: string, now: number): Promise<KeyObject | "unknown_kid" | "jwks_unavailable"> {
  const state = jwksStateFor(injected);
  const fetchFn = injected ?? globalThis.fetch;
  const cached = state.entry;
  if (cached && now < cached.expiresAt) {
    const key = cached.keys.get(kid);
    if (key) return key;
  }
  if (state.inflight) {
    await state.inflight;
  } else if (state.lastAttemptAt === undefined || now - state.lastAttemptAt >= JWKS_REFETCH_INTERVAL_MS) {
    state.lastAttemptAt = now;
    state.inflight = loadJwks(fetchFn, now)
      .then(
        (entry) => {
          state.entry = entry;
        },
        // 取得の失敗は検証の失敗として扱う（理由は返さない。古いキャッシュがあればそれで続ける）
        () => undefined,
      )
      .finally(() => {
        state.inflight = undefined;
      });
    await state.inflight;
  }
  const entry = state.entry;
  if (!entry || now - entry.expiresAt > JWKS_STALE_LIMIT_MS) return "jwks_unavailable";
  return entry.keys.get(kid) ?? "unknown_kid";
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkClaims(payload: Record<string, unknown>, options: VerifyGoogleOidcOptions, nowMs: number): OidcVerifyResult {
  if (typeof payload.iss !== "string" || !GOOGLE_ISSUERS.has(payload.iss)) return fail("bad_issuer");
  // aud は 1 つの文字列だけ（配列は受けない）
  if (typeof payload.aud !== "string" || payload.aud !== options.audience) return fail("bad_audience");
  const { exp, iat, nbf } = payload;
  if (!isNumericDate(exp) || !isNumericDate(iat) || (nbf !== undefined && !isNumericDate(nbf))) return fail("invalid_claims");
  const now = nowMs / 1000;
  if (now >= exp + CLOCK_SKEW_SECONDS) return fail("expired");
  if (nbf !== undefined && nbf > now + CLOCK_SKEW_SECONDS) return fail("not_yet_valid");
  if (iat > now + CLOCK_SKEW_SECONDS) return fail("issued_in_future");
  if (typeof payload.email !== "string" || payload.email !== options.allowedEmail) return fail("bad_email");
  if (payload.email_verified !== true) return fail("email_unverified");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return fail("missing_subject");
  return { ok: true };
}

async function verify(token: unknown, options: VerifyGoogleOidcOptions): Promise<OidcVerifyResult> {
  // 期待する値が空なら（設定の誤り）何も通さない
  if (!options.audience) return fail("bad_audience");
  if (!options.allowedEmail) return fail("bad_email");
  if (typeof token !== "string" || token.length === 0) return fail("malformed");
  if (token.length > MAX_TOKEN_LENGTH) return fail("token_too_large");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJsonObject(encodedHeader);
  const payload = decodeJsonObject(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!header || !payload || !signature) return fail("malformed");
  if (header.alg !== "RS256") return fail("unsupported_alg");
  // 理解しない拡張（crit）は受けない（RFC 7515 §4.1.11）
  if (header.crit !== undefined) return fail("malformed");
  if (typeof header.kid !== "string" || !KID_PATTERN.test(header.kid)) return fail("missing_kid");

  const nowMs = options.now?.() ?? Date.now();
  const key = await findKey(options.fetch, header.kid, nowMs);
  if (typeof key === "string") return fail(key);
  let valid: boolean;
  try {
    valid = verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"), key, signature);
  } catch {
    valid = false;
  }
  // 署名が通ってからクレームを見る
  if (!valid) return fail("bad_signature");
  return checkClaims(payload, options, nowMs);
}

/** Google の ID トークンを検証する。例外は投げない（想定外の失敗も `malformed`）。 */
export async function verifyGoogleOidc(token: unknown, options: VerifyGoogleOidcOptions): Promise<OidcVerifyResult> {
  try {
    return await verify(token, options);
  } catch {
    return fail("malformed");
  }
}
