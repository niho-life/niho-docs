/**
 * Minimal typings for the standard globals the connection code uses (Web Crypto, TextEncoder).
 * Declared here so the sources compile against the ES lib only, like the contract's runtime.
 */

interface StandardGlobals {
  readonly TextEncoder: new () => { encode(input: string): Uint8Array };
  readonly crypto?: {
    getRandomValues?(array: Uint8Array): Uint8Array;
    readonly subtle?: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
  };
}

const standard = globalThis as unknown as StandardGlobals;

/** UTF-8 bytes of `text` (lone surrogates become U+FFFD). */
export function utf8(text: string): Uint8Array {
  return new standard.TextEncoder().encode(text);
}

/** `n` bytes from the platform CSPRNG. Throws when Web Crypto is missing. */
export function webCryptoBytes(n: number): Uint8Array {
  const getRandomValues = standard.crypto?.getRandomValues;
  if (typeof getRandomValues !== "function") throw new Error("Web Crypto (crypto.getRandomValues) is required");
  const bytes = new Uint8Array(n);
  getRandomValues.call(standard.crypto, bytes);
  return bytes;
}

/** Lowercase hex SHA-256 of raw bytes. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = standard.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is required");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
