/**
 * Credential shapes. Generation, hash storage and comparison belong to the
 * server. Never log, persist or format a plaintext key or token except through
 * maskKey.
 */

export const CONNECTION_KEY_PREFIX = "ek_" as const;
export const PREVIEW_TOKEN_PREFIX = "pv_" as const;

// 256 random bits as unpadded base64url: 43 characters, the last one carrying 4 bits.
const RANDOM_256 = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
const CONNECTION_KEY_PATTERN = new RegExp(`^ek_${RANDOM_256}$`);
const PREVIEW_TOKEN_PATTERN = new RegExp(`^pv_${RANDOM_256}$`);

export const MASKED_KEY_PREFIX = "ek_••••••••" as const;
export const MAX_AUTHORIZATION_LENGTH = 4096;

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/** `ek_` + 43 base64url characters (canonical 256-bit encoding). */
export function isConnectionKey(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_KEY_PATTERN.test(value);
}

/** `pv_` + 43 base64url characters (canonical 256-bit encoding). */
export function isPreviewToken(value: unknown): value is string {
  return typeof value === "string" && PREVIEW_TOKEN_PATTERN.test(value);
}

/** `ek_••••••••` + the last 4 characters. Anything that is not a key reveals nothing. */
export function maskKey(key: string): string {
  return isConnectionKey(key) ? `${MASKED_KEY_PREFIX}${key.slice(-4)}` : MASKED_KEY_PREFIX;
}

/**
 * Credential from an Authorization header, or null for a missing, empty,
 * non-Bearer, multi-valued or oversized header. The result is secret.
 */
export function parseBearer(header: string | readonly string[] | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  let value: string;
  if (typeof header === "string") value = header;
  else if (header.length === 1 && typeof header[0] === "string") value = header[0];
  else return null;
  if (value.length === 0 || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BEARER_PATTERN.exec(value);
  return match?.[1] ?? null;
}
