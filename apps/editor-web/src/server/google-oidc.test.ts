import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  GOOGLE_JWKS_URL,
  JWKS_REFETCH_INTERVAL_MS,
  JWKS_STALE_LIMIT_MS,
  MAX_TOKEN_LENGTH,
  verifyGoogleOidc,
  type OidcVerifyResult,
} from "./google-oidc";

// テストの中で作った鍵と、合成の値だけを使う（本物の鍵・プロジェクト・メールを入れない）
const AUDIENCE = "https://worker.example.test";
const EMAIL = "synthetic-tasks@synthetic-project.iam.gserviceaccount.com";
const SUBJECT = "100000000000000000001";
const NOW_SECONDS = 1_900_000_000;
const NOW = NOW_SECONDS * 1000;

const KID = "synthetic-kid-1";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const weakPair = generateKeyPairSync("rsa", { modulusLength: 1024 });

function jwkOf(publicKey: KeyObject, kid: string, extra: Record<string, unknown> = { alg: "RS256", use: "sig" }) {
  return { ...publicKey.export({ format: "jwk" }), kid, ...extra };
}

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

type Claims = Record<string, unknown>;

function claims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    azp: SUBJECT,
    sub: SUBJECT,
    email: EMAIL,
    email_verified: true,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3590,
    ...overrides,
  };
}

/** 削除したいクレームは undefined にする（JSON.stringify が落とす）。 */
function token(payload: Claims = claims(), header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" }, privateKey: KeyObject = pair.privateKey): string {
  const signingInput = `${b64(header)}.${b64(payload)}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

type Jwks = { keys: unknown[] };

/** JWKS を返す偽の fetch（呼ばれた回数と URL を数える）。`respond` で応答を差し替える。 */
function jwksFetch(initial: Jwks = { keys: [jwkOf(pair.publicKey, KID)] }, cacheControl = "public, max-age=300, must-revalidate") {
  const state: { jwks: Jwks; cacheControl: string; respond?: () => Response | Promise<Response> } = { jwks: initial, cacheControl };
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    void input;
    if (state.respond) return state.respond();
    return new Response(JSON.stringify(state.jwks), { status: 200, headers: { "content-type": "application/json", "cache-control": state.cacheControl } });
  });
  return { fetch: fn as unknown as typeof fetch, calls: fn.mock.calls, state };
}

function verifier(fake = jwksFetch(), clock: { now: number } = { now: NOW }) {
  return {
    fake,
    clock,
    verify: (value: unknown, expected: { audience?: string; allowedEmail?: string } = {}) =>
      verifyGoogleOidc(value, { audience: AUDIENCE, allowedEmail: EMAIL, ...expected, fetch: fake.fetch, now: () => clock.now }),
  };
}

const rejected = (code: string): OidcVerifyResult => ({ ok: false, code } as OidcVerifyResult);

describe("verifyGoogleOidc", () => {
  it("accepts a Google ID token signed by a key from the fixed JWKS URL, with either issuer form", async () => {
    const { verify, fake } = verifier();
    expect(await verify(token())).toEqual({ ok: true });
    expect(await verify(token(claims({ iss: "accounts.google.com" })))).toEqual({ ok: true });
    // nbf があっても今より前なら通る
    expect(await verify(token(claims({ nbf: NOW_SECONDS - 10 })))).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(String(fake.calls[0]?.[0])).toBe(GOOGLE_JWKS_URL);
    expect(new URL(GOOGLE_JWKS_URL).host).toBe("www.googleapis.com");
  });

  it("refuses every algorithm except RS256, including none and the HS256 key confusion", async () => {
    const { verify, fake } = verifier();
    const payload = b64(claims());
    // alg: none（署名なし・署名つきのどちらも）
    expect(await verify(`${b64({ alg: "none", kid: KID })}.${payload}.`)).toEqual(rejected("malformed"));
    expect(await verify(`${b64({ alg: "none", kid: KID })}.${payload}.${b64("x")}`)).toEqual(rejected("unsupported_alg"));
    // HS256 で、公開鍵（PEM・JWK の n）を HMAC の鍵に見せかける
    for (const secret of [pair.publicKey.export({ type: "spki", format: "pem" }).toString(), String(jwkOf(pair.publicKey, KID).n)]) {
      const input = `${b64({ alg: "HS256", kid: KID, typ: "JWT" })}.${payload}`;
      expect(await verify(`${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`)).toEqual(rejected("unsupported_alg"));
    }
    for (const alg of ["RS512", "RS384", "PS256", "ES256", "rs256", "RS256 ", "", null, undefined, ["RS256"]]) {
      expect(await verify(token(claims(), { alg, kid: KID }))).toEqual(rejected("unsupported_alg"));
    }
    // RS256 以外では鍵を取りにも行かない
    expect(fake.calls).toHaveLength(0);
  });

  it("requires a kid and looks keys up only in the fixed JWKS (never in the token's own jwk / jku)", async () => {
    const { verify } = verifier();
    for (const kid of [undefined, "", 7, "has space", "k".repeat(129)]) {
      expect(await verify(token(claims(), { alg: "RS256", kid }))).toEqual(rejected("missing_kid"));
    }
    expect(await verify(token(claims(), { alg: "RS256", kid: "synthetic-kid-unknown" }))).toEqual(rejected("unknown_kid"));
    // 攻撃者の鍵で署名し、その鍵を header に埋めても・既知の kid を名乗っても通らない
    const attacker = { alg: "RS256", kid: "attacker", jwk: jwkOf(otherPair.publicKey, "attacker"), jku: "https://attacker.example.test/certs" };
    expect(await verify(token(claims(), attacker, otherPair.privateKey))).toEqual(rejected("unknown_kid"));
    expect(await verify(token(claims(), { alg: "RS256", kid: KID, jwk: jwkOf(otherPair.publicKey, KID) }, otherPair.privateKey))).toEqual(rejected("bad_signature"));
    // 理解しない拡張（crit）は受けない
    expect(await verify(token(claims(), { alg: "RS256", kid: KID, crit: ["exp"] }))).toEqual(rejected("malformed"));
  });

  it("refuses a token whose header, payload or signature was changed by one character", async () => {
    const { verify } = verifier();
    const original = token();
    const [header, payload, signature] = original.split(".") as [string, string, string];
    const flip = (part: string, at: number) => `${part.slice(0, at)}${part[at] === "A" ? "B" : "A"}${part.slice(at + 1)}`;
    for (const changed of [
      `${flip(header, 5)}.${payload}.${signature}`,
      `${header}.${flip(payload, 10)}.${signature}`,
      `${header}.${payload}.${flip(signature, 20)}`,
      `${header}.${payload}.${flip(signature, 0)}`,
    ]) {
      const result = await verify(changed);
      expect(result.ok).toBe(false);
    }
    // 形は正しいまま中身だけを替えたもの（同じ署名）は署名で落ちる
    expect(await verify(`${b64({ alg: "RS256", kid: KID, typ: "JWS" })}.${payload}.${signature}`)).toEqual(rejected("bad_signature"));
    expect(await verify(`${header}.${b64(claims({ sub: "100000000000000000002" }))}.${signature}`)).toEqual(rejected("bad_signature"));
    expect(await verify(`${header}.${b64(claims({ email: "other@synthetic-project.iam.gserviceaccount.com" }))}.${signature}`)).toEqual(rejected("bad_signature"));
    expect(await verify(`${header}.${payload}.${flip(signature, 20)}`)).toEqual(rejected("bad_signature"));
    // 別の鍵の署名
    expect(await verify(token(claims(), undefined, otherPair.privateKey))).toEqual(rejected("bad_signature"));
  });

  it("checks iss and aud exactly", async () => {
    const { verify } = verifier();
    for (const iss of ["https://accounts.google.com/", "http://accounts.google.com", "https://attacker.example.test", undefined, 1]) {
      expect(await verify(token(claims({ iss })))).toEqual(rejected("bad_issuer"));
    }
    for (const aud of [`${AUDIENCE}/`, `${AUDIENCE}/api/internal/steps/run`, "https://other.example.test", [AUDIENCE], undefined, ""]) {
      expect(await verify(token(claims({ aud })))).toEqual(rejected("bad_audience"));
    }
    expect(await verify(token(), { audience: "https://other.example.test" })).toEqual(rejected("bad_audience"));
    // 期待する値が空（設定の誤り）なら何も通さない
    expect(await verify(token(claims({ aud: "" })), { audience: "" })).toEqual(rejected("bad_audience"));
    expect(await verify(token(claims({ email: "" })), { allowedEmail: "" })).toEqual(rejected("bad_email"));
  });

  it("checks exp, nbf and iat with 60 seconds of clock skew", async () => {
    const { verify, clock } = verifier();
    const exp = NOW_SECONDS + 100;
    clock.now = (exp + CLOCK_SKEW_SECONDS - 1) * 1000;
    expect(await verify(token(claims({ exp, iat: NOW_SECONDS })))).toEqual({ ok: true });
    clock.now = (exp + CLOCK_SKEW_SECONDS + 1) * 1000;
    expect(await verify(token(claims({ exp, iat: NOW_SECONDS })))).toEqual(rejected("expired"));

    clock.now = NOW;
    expect(await verify(token(claims({ nbf: NOW_SECONDS + CLOCK_SKEW_SECONDS - 1 })))).toEqual({ ok: true });
    expect(await verify(token(claims({ nbf: NOW_SECONDS + CLOCK_SKEW_SECONDS + 1 })))).toEqual(rejected("not_yet_valid"));
    expect(await verify(token(claims({ iat: NOW_SECONDS + CLOCK_SKEW_SECONDS - 1 })))).toEqual({ ok: true });
    expect(await verify(token(claims({ iat: NOW_SECONDS + CLOCK_SKEW_SECONDS + 1 })))).toEqual(rejected("issued_in_future"));

    for (const overrides of [{ exp: undefined }, { exp: "1900003600" }, { iat: undefined }, { iat: null }, { nbf: "0" }, { exp: Number.NaN }]) {
      expect(await verify(token(claims(overrides)))).toEqual(rejected("invalid_claims"));
    }
  });

  it("allows exactly one verified service account email and requires a subject", async () => {
    const { verify } = verifier();
    for (const email of ["other@synthetic-project.iam.gserviceaccount.com", EMAIL.toUpperCase(), ` ${EMAIL}`, undefined, [EMAIL]]) {
      expect(await verify(token(claims({ email })))).toEqual(rejected("bad_email"));
    }
    expect(await verify(token(), { allowedEmail: "other@synthetic-project.iam.gserviceaccount.com" })).toEqual(rejected("bad_email"));
    for (const verified of [false, "true", 1, undefined]) {
      expect(await verify(token(claims({ email_verified: verified })))).toEqual(rejected("email_unverified"));
    }
    for (const sub of [undefined, "", 1]) {
      expect(await verify(token(claims({ sub })))).toEqual(rejected("missing_subject"));
    }
  });

  it("refuses tokens that are not three Base64URL parts of JSON objects, and oversized tokens, without fetching keys", async () => {
    const { verify, fake } = verifier();
    const [header, payload, signature] = token().split(".") as [string, string, string];
    for (const value of [
      "",
      undefined,
      42,
      `${header}.${payload}`,
      `${header}.${payload}.${signature}.${signature}`,
      `${header}..${signature}`,
      `${header}+.${payload}.${signature}`,
      `${header}.${payload}.${signature}=`,
      `${header}.${payload}.${signature.slice(0, 10)}/${signature.slice(11)}`,
      `${header}.${payload}.!`,
      // 長さが 4 で割って 1 余る Base64URL は無い
      `${header}.${payload}.${signature}AAA`,
      `${b64("not json")}.${payload}.${signature}`,
      `${b64([1, 2])}.${payload}.${signature}`,
      `${header}.${b64("null")}.${signature}`,
      `${header}.${b64([claims()])}.${signature}`,
      `${header}.${Buffer.from([0xff, 0xfe]).toString("base64url")}.${signature}`,
    ]) {
      expect(await verify(value)).toEqual(rejected("malformed"));
    }
    expect(await verify(`${header}.${payload}.${signature}${"A".repeat(MAX_TOKEN_LENGTH)}`)).toEqual(rejected("token_too_large"));
    expect(await verify(token(claims({ pad: "x".repeat(MAX_TOKEN_LENGTH) })))).toEqual(rejected("token_too_large"));
    expect(fake.calls).toHaveLength(0);
    // 形は正しいが長さの違う署名は、鍵で確かめて落ちる
    expect(await verify(`${header}.${payload}.${signature}${"A".repeat(4)}`)).toEqual(rejected("bad_signature"));
  });

  it("refuses the non-canonical Base64URL spelling of the same signature bytes", async () => {
    const { verify } = verifier();
    const original = token();
    const [header, payload, signature] = original.split(".") as [string, string, string];
    // 2048 bit の署名は 256 bytes → 342 文字で、最後の文字の下位 4 bit は使われない
    expect(signature.length % 4).toBe(2);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1)!);
    const twin = `${signature.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(twin, "base64url").equals(Buffer.from(signature, "base64url"))).toBe(true);
    expect(await verify(original)).toEqual({ ok: true });
    expect(await verify(`${header}.${payload}.${twin}`)).toEqual(rejected("malformed"));
  });

  it("refuses when the JWKS cannot be fetched and nothing is cached, and keeps going on the stale cache when it can", async () => {
    const down = jwksFetch();
    down.state.respond = () => new Response("unavailable", { status: 503 });
    const cold = verifier(down);
    expect(await cold.verify(token())).toEqual(rejected("jwks_unavailable"));
    const throwing = jwksFetch();
    throwing.state.respond = () => Promise.reject(new TypeError("synthetic network failure"));
    expect(await verifier(throwing).verify(token())).toEqual(rejected("jwks_unavailable"));
    for (const body of ["not json", JSON.stringify({ keys: [] }), JSON.stringify({ keys: [{ kty: "EC", kid: KID }] }), JSON.stringify([]), "x".repeat(70_000)]) {
      const broken = jwksFetch();
      broken.state.respond = () => new Response(body, { status: 200 });
      expect(await verifier(broken).verify(token())).toEqual(rejected("jwks_unavailable"));
    }

    const flaky = jwksFetch();
    const warm = verifier(flaky);
    expect(await warm.verify(token())).toEqual({ ok: true });
    flaky.state.respond = () => new Response("unavailable", { status: 503 });
    warm.clock.now = NOW + 301_000;
    // 期限が切れ、取り直しに失敗しても、古い鍵で続ける
    expect(await warm.verify(token(claims({ iat: NOW_SECONDS + 300, exp: NOW_SECONDS + 3900 })))).toEqual({ ok: true });
    expect(flaky.calls).toHaveLength(2);
    // ただし期限切れから 24 時間を過ぎた古い鍵では続けない
    warm.clock.now = NOW + 300_000 + JWKS_STALE_LIMIT_MS + 1000;
    const late = NOW_SECONDS + 300 + JWKS_STALE_LIMIT_MS / 1000;
    expect(await warm.verify(token(claims({ iat: late, exp: late + 3600 })))).toEqual(rejected("jwks_unavailable"));
  });

  it("caches the JWKS for its max-age, kept between 60 seconds and 1 hour", async () => {
    const cases: [string, number][] = [
      ["public, max-age=300, must-revalidate", 300],
      ["public, max-age=10", 60],
      ["no-cache", 60],
      ["public, max-age=86400", 3600],
    ];
    for (const [cacheControl, seconds] of cases) {
      const fake = jwksFetch(undefined, cacheControl);
      const { verify, clock } = verifier(fake);
      const at = (offsetSeconds: number) => {
        clock.now = NOW + offsetSeconds * 1000;
        return verify(token(claims({ iat: NOW_SECONDS + offsetSeconds - 10, exp: NOW_SECONDS + offsetSeconds + 3590 })));
      };
      expect(await at(0)).toEqual({ ok: true });
      expect(await at(seconds - 1)).toEqual({ ok: true });
      expect(fake.calls, cacheControl).toHaveLength(1);
      expect(await at(seconds)).toEqual({ ok: true });
      expect(fake.calls, cacheControl).toHaveLength(2);
    }
  });

  it("refetches once for an unknown kid (at most every 30 seconds) and picks up a rotated key", async () => {
    const fake = jwksFetch();
    const { verify, clock } = verifier(fake);
    expect(await verify(token())).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);

    const unknown = token(claims(), { alg: "RS256", kid: "synthetic-kid-unknown" });
    clock.now = NOW + JWKS_REFETCH_INTERVAL_MS;
    expect(await verify(unknown)).toEqual(rejected("unknown_kid"));
    expect(fake.calls).toHaveLength(2);
    // 30 秒の間は取り直さない（未知の kid を並べて鍵の取得を連打させない）
    for (let i = 0; i < 5; i++) expect(await verify(unknown)).toEqual(rejected("unknown_kid"));
    clock.now = NOW + 2 * JWKS_REFETCH_INTERVAL_MS - 1;
    expect(await verify(unknown)).toEqual(rejected("unknown_kid"));
    expect(fake.calls).toHaveLength(2);

    // 鍵が替わった: 新しい kid が JWKS に出たら、次の取り直しで通る（キャッシュの期限内でも）
    fake.state.jwks = { keys: [jwkOf(pair.publicKey, KID), jwkOf(otherPair.publicKey, "synthetic-kid-2")] };
    clock.now = NOW + 2 * JWKS_REFETCH_INTERVAL_MS;
    expect(await verify(token(claims(), { alg: "RS256", kid: "synthetic-kid-2" }, otherPair.privateKey))).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(3);
    // 既知の kid は取り直さない
    expect(await verify(token())).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(3);
  });

  it("shares one JWKS fetch between concurrent requests on a cold cache", async () => {
    const fake = jwksFetch();
    const { verify } = verifier(fake);
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(token())));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
    expect(fake.calls).toHaveLength(1);
  });

  it("ignores keys that are not RS256 signing RSA keys of at least 2048 bits", async () => {
    const keys = [
      jwkOf(weakPair.publicKey, "weak"),
      jwkOf(pair.publicKey, "enc", { alg: "RS256", use: "enc" }),
      jwkOf(pair.publicKey, "rs512", { alg: "RS512" }),
      { kty: "RSA", kid: "broken", n: "AQAB", e: "AQAB" },
      jwkOf(pair.publicKey, KID),
    ];
    const { verify } = verifier(jwksFetch({ keys }));
    expect(await verify(token())).toEqual({ ok: true });
    expect(await verify(token(claims(), { alg: "RS256", kid: "weak" }, weakPair.privateKey))).toEqual(rejected("unknown_kid"));
    expect(await verify(token(claims(), { alg: "RS256", kid: "enc" }))).toEqual(rejected("unknown_kid"));
    expect(await verify(token(claims(), { alg: "RS256", kid: "rs512" }))).toEqual(rejected("unknown_kid"));
  });

  it("never puts the token or the claim values in its result, and logs nothing", async () => {
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log"), vi.spyOn(console, "info")];
    try {
      const { verify } = verifier();
      const samples = [
        token(claims({ email: "leak-check@synthetic-project.iam.gserviceaccount.com" })),
        token(claims({ aud: "https://leak-check.example.test" })),
        token(claims({ iss: "https://leak-check.example.test" })),
        token(claims({ sub: "" , email_verified: "leak-check" })),
        token(claims(), { alg: "HS256", kid: "leak-check" }),
        token(claims(), { alg: "RS256", kid: "leak-check" }),
        `${token().slice(0, -3)}AAA`,
        "leak-check.leak-check.leak-check",
      ];
      for (const sample of samples) {
        const result = await verify(sample);
        expect(result.ok).toBe(false);
        const text = JSON.stringify(result);
        expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
        expect(text).not.toContain("leak-check");
        for (const part of sample.split(".")) if (part.length > 8) expect(text).not.toContain(part.slice(0, 16));
        expect(text).not.toContain(SUBJECT);
        expect(text).not.toContain(EMAIL);
        expect(text).not.toContain(AUDIENCE);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
