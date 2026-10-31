/**
 * 公開 API v1 の rate limit（429 ＋ Retry-After）。資格の SHA-256 ごとの固定窓（窓は時計の分の区切り）。
 *
 * 数えるのは instance（Cloud Run の 1 container）の中だけで、instance をまたいで合算しない。instance が増えると、
 * 全体で受ける上限はおおよそ instance の数の倍になる。正確な閾値は契約で公開しない（rate_limited の本文に値を出さない）。
 */

export interface RateLimitSettings {
  /** 1 つの窓で 1 つの資格が通せる要求の数。 */
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMIT_ENV = "EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE";

/** 既定は緩め（発信先が一定間隔で一覧と公開版を読み直す使い方で当たらない値）。 */
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { limit: 600, windowMs: 60_000 };

/** 1 つの窓で数える資格の数の上限（偽の資格を大量に送られても memory を使い切らない。超えた分は数えずに通す）。 */
export const MAX_TRACKED_CREDENTIALS = 10_000;

/** `EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE`（1 以上の整数）。未設定は既定、読めない値は "invalid"（呼ぶ側が既定にする）。 */
export function parseRateLimit(raw: string | undefined): RateLimitSettings | "unset" | "invalid" {
  if (raw === undefined || raw.trim() === "") return "unset";
  if (!/^[1-9][0-9]{0,8}$/.test(raw.trim())) return "invalid";
  return { limit: Number(raw.trim()), windowMs: 60_000 };
}

export function rateLimitFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): RateLimitSettings {
  const parsed = parseRateLimit(env[RATE_LIMIT_ENV]);
  return parsed === "unset" || parsed === "invalid" ? DEFAULT_RATE_LIMIT : parsed;
}

export type RateLimitDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /** key（資格の SHA-256）の要求を 1 つ数える。上限を超えたら次の窓までの秒数。 */
  take(key: string, nowMs: number): RateLimitDecision;
}

export function createFixedWindowLimiter(settings: RateLimitSettings, maxTracked: number = MAX_TRACKED_CREDENTIALS): RateLimiter {
  let window = Number.NaN;
  let counts = new Map<string, number>();
  return {
    take(key, nowMs) {
      const current = Math.floor(nowMs / settings.windowMs);
      if (current !== window) {
        // 窓が変わったら数え直す（前の窓の分は全て捨てる）
        window = current;
        counts = new Map();
      }
      const count = counts.get(key);
      if (count === undefined) {
        if (counts.size < maxTracked) counts.set(key, 1);
        return { ok: true };
      }
      if (count >= settings.limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil(((current + 1) * settings.windowMs - nowMs) / 1000));
        return { ok: false, retryAfterSeconds };
      }
      counts.set(key, count + 1);
      return { ok: true };
    },
  };
}
