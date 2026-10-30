/**
 * Minimal typings for the standard globals this package uses (WHATWG URL,
 * TextEncoder, Web Crypto). Declared here so the sources compile against the
 * ES lib only and stay free of DOM / Node type dependencies.
 */

interface ParsedUrl {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

interface StandardGlobals {
  readonly URL: new (input: string, base?: string) => ParsedUrl;
  readonly TextEncoder: new () => { encode(input: string): Uint8Array };
  readonly crypto?: {
    readonly subtle?: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
  };
}

const standard = globalThis as unknown as StandardGlobals;

export function parseUrl(input: string, base?: string): ParsedUrl {
  return base === undefined ? new standard.URL(input) : new standard.URL(input, base);
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = standard.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is required");
  const digest = await subtle.digest("SHA-256", new standard.TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
