import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleAuthProvider, LOGIN_COOKIE, LOGIN_TTL_SECONDS, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./google";
import { GOOGLE_JWKS_URL } from "../server/google-oidc";

// 本物の鍵・クライアント・アドレスは使わない（すべてこのテストの中で作った合成の値）
const CLIENT_ID = "synthetic-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "synthetic-client-secret";
const ALLOWED = "owner@example.test";
const ALLOWED_SECOND = "owner.second@example.invalid";
const OUTSIDE = "someone-else@example.test";
const SUBJECT = "100000000000000000001";
const ORIGIN = "https://editor.example.test";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTHORIZE_HOST = "accounts.google.com";
const NOW_SECONDS = 1_900_000_000;
const NOW = NOW_SECONDS * 1000;
const KID = "synthetic-kid-1";
const CODE = "synthetic-authorization-code";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

type Claims = Record<string, unknown>;

function claims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: SUBJECT,
    email: ALLOWED,
    email_verified: true,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3590,
    ...overrides,
  };
}

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function idToken(payload: Claims = claims(), privateKey: KeyObject = pair.privateKey): string {
  const signingInput = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64(payload)}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

function jwks(): string {
  return JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
}

type GoogleOptions = { token?: () => Response; payload?: Claims };

/** Google の 2 つの口（token の交換と JWKS）だけに答える偽の fetch。 */
function fakeGoogle(options: GoogleOptions = {}) {
  const requests: { url: string; method: string; body: string }[] = [];
  const issued: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    if (url === GOOGLE_JWKS_URL) {
      return new Response(jwks(), { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
    }
    if (url === TOKEN_URL) {
      if (options.token) return options.token();
      const token = idToken(options.payload ?? claims());
      issued.push(token);
      const body = { access_token: "synthetic-access-token", token_type: "Bearer", id_token: token };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fetch: fetchFn as unknown as typeof fetch, requests, issued };
}

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    EDITOR_AUTH_MODE: "google",
    EDITOR_ORIGIN: ORIGIN,
    EDITOR_GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    EDITOR_GOOGLE_ALLOWED_EMAILS: `${ALLOWED},${ALLOWED_SECOND}`,
    ...overrides,
  };
}

/** state と PKCE の verifier は決まった値にする（本番は 32 バイトの乱数）。 */
function randomValues() {
  let index = 0;
  return () => `synthetic-random-${++index}`;
}

function provider(options: { google?: ReturnType<typeof fakeGoogle>; env?: Record<string, string | undefined>; now?: () => number } = {}) {
  const google = options.google ?? fakeGoogle();
  const auth = createGoogleAuthProvider({
    env: () => options.env ?? environment(),
    fetch: google.fetch,
    now: options.now ?? (() => NOW),
    randomValue: randomValues(),
  });
  return { auth, google };
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieNamed(response: Response, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValueOf(response: Response, name: string): string {
  const cookie = cookieNamed(response, name);
  return cookie ? (cookie.split(";")[0] ?? "").slice(name.length + 1) : "";
}

/** ログインの開始 → Google からの戻り、までを通す。 */
async function startLogin(auth: ReturnType<typeof provider>["auth"], returnTo = "/settings") {
  const response = await auth.beginLogin({ request: new Request(`${ORIGIN}/auth/login/start?next=${encodeURIComponent(returnTo)}`), returnTo });
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location, state: location.searchParams.get("state") ?? "", cookie: cookieValueOf(response, LOGIN_COOKIE) };
}

async function callback(
  auth: ReturnType<typeof provider>["auth"],
  input: { state: string; cookie?: string; code?: string; query?: string },
): Promise<Response> {
  const params = new URLSearchParams({ state: input.state, code: input.code ?? CODE });
  const url = `${ORIGIN}/auth/callback?${params.toString()}${input.query ?? ""}`;
  const headers = input.cookie === undefined ? undefined : { cookie: `${LOGIN_COOKIE}=${input.cookie}` };
  return auth.completeLogin(new Request(url, headers ? { headers } : undefined));
}

/** ログインを最後まで通して、できたセッションの cookie を返す。 */
async function signIn(options: Parameters<typeof provider>[0] = {}) {
  const { auth, google } = provider(options);
  const started = await startLogin(auth);
  const finished = await callback(auth, { state: started.state, cookie: started.cookie });
  return { auth, google, started, finished, session: cookieValueOf(finished, SESSION_COOKIE) };
}

const session = (value: string) => ({ headers: new Headers({ cookie: `${SESSION_COOKIE}=${value}` }) });

/** ログに出た行（失敗の種類だけが出ることを確かめる。本文は画面にもログにも出さない）。 */
const logged: unknown[][] = [];

beforeEach(() => {
  logged.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("beginLogin", () => {
  it("sends the person to Google with PKCE, only the openid email scope, and keeps state and verifier in a short-lived cookie", async () => {
    const { auth } = provider();
    const { response, location, cookie } = await startLogin(auth);

    expect(response.status).toBe(303);
    expect(location.origin).toBe(`https://${AUTHORIZE_HOST}`);
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get("response_type")).toBe("code");
    // Drive などは混ぜない
    expect(location.searchParams.get("scope")).toBe("openid email");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe(createHash("sha256").update("synthetic-random-2").digest("base64url"));
    expect(location.searchParams.get("state")).toBe("synthetic-random-1");
    // verifier そのものは URL に出さない（challenge だけ）
    expect(location.toString()).not.toContain("synthetic-random-2");

    const loginCookie = cookieNamed(response, LOGIN_COOKIE) ?? "";
    expect(loginCookie).toContain("HttpOnly");
    expect(loginCookie).toContain("Secure");
    expect(loginCookie).toContain("SameSite=Lax");
    expect(loginCookie).toContain("Path=/");
    expect(loginCookie).toContain(`Max-Age=${LOGIN_TTL_SECONDS}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // cookie は署名付きで、state と戻り先を持つ（verifier は中にあるが、ブラウザの JavaScript からは読めない）
    expect(cookie.split(".")).toHaveLength(2);
  });

  it("cannot start while the client id, the secret or the allowlist is missing", async () => {
    for (const missing of [{ EDITOR_GOOGLE_CLIENT_ID: undefined }, { GOOGLE_OAUTH_CLIENT_SECRET: undefined }, { EDITOR_GOOGLE_ALLOWED_EMAILS: "" }]) {
      const { auth } = provider({ env: environment(missing) });
      const response = await auth.beginLogin({ request: new Request(`${ORIGIN}/auth/login/start`), returnTo: "/settings" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
      expect(setCookies(response)).toEqual([]);
      expect(await auth.getSession({ headers: new Headers() })).toBeNull();
    }
  });
});

describe("completeLogin", () => {
  it("signs in a listed address and leaves a server-signed session cookie with no token in it", async () => {
    const { auth, google, finished, session: value } = await signIn();

    expect(finished.status).toBe(303);
    expect(finished.headers.get("location")).toBe("/settings");
    const sessionCookie = cookieNamed(finished, SESSION_COOKIE) ?? "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // ログインの途中の cookie は消える
    expect(cookieNamed(finished, LOGIN_COOKIE)).toContain("Max-Age=0");

    // code は POST の本文で交換し、ID トークンと access token はどの応答の header にも出さない
    const exchange = google.requests.find((request) => request.url === TOKEN_URL);
    expect(exchange?.method).toBe("POST");
    expect(exchange?.body).toContain(`code=${CODE}`);
    expect(exchange?.body).toContain("code_verifier=synthetic-random-2");
    const headers = JSON.stringify([...finished.headers]);
    expect(headers).not.toContain("synthetic-access-token");
    expect(google.issued).toHaveLength(1);
    expect(headers).not.toContain(google.issued[0]);

    const current = await auth.getSession(session(value));
    expect(current).toEqual({ userId: SUBJECT, mode: "google", profile: { name: ALLOWED, email: ALLOWED } });
  });

  it("accepts every address on the list, whatever case Google sends", async () => {
    for (const email of [ALLOWED, ALLOWED_SECOND, ALLOWED_SECOND.toUpperCase()]) {
      const { auth, session: value } = await signIn({ google: fakeGoogle({ payload: claims({ email, sub: `${SUBJECT}-${email.length}` }) }) });
      expect((await auth.getSession(session(value)))?.profile?.email, email).toBe(email.toLowerCase());
    }
  });

  it("refuses an address that is not on the list, without naming it", async () => {
    const { finished } = await signIn({ google: fakeGoogle({ payload: claims({ email: OUTSIDE }) }) });
    expect(finished.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=forbidden");
    expect(cookieNamed(finished, SESSION_COOKIE)).toBeUndefined();
    const everything = `${JSON.stringify([...finished.headers])}${JSON.stringify(logged)}`;
    expect(everything).not.toContain(OUTSIDE);
    expect(everything).not.toContain(OUTSIDE.split("@")[0]);
  });

  it("refuses a state that does not match the cookie, a missing state or code, and a missing cookie", async () => {
    const cases: { label: string; run: (auth: ReturnType<typeof provider>["auth"], started: Awaited<ReturnType<typeof startLogin>>) => Promise<Response> }[] = [
      { label: "another state", run: (auth, started) => callback(auth, { state: "synthetic-random-9", cookie: started.cookie }) },
      { label: "no state", run: (auth, started) => callback(auth, { state: "", cookie: started.cookie }) },
      { label: "no code", run: (auth, started) => callback(auth, { state: started.state, cookie: started.cookie, code: "" }) },
      { label: "no cookie", run: (auth, started) => callback(auth, { state: started.state }) },
      { label: "a cookie signed with another secret", run: async (auth, started) => callback(auth, { state: started.state, cookie: `${started.cookie.split(".")[0]}.tampered` }) },
      { label: "Google reported an error", run: (auth, started) => callback(auth, { state: started.state, cookie: started.cookie, query: "&error=access_denied" }) },
    ];
    for (const { label, run } of cases) {
      const { auth, google } = provider();
      const started = await startLogin(auth);
      const response = await run(auth, started);
      expect(response.status, label).toBe(303);
      expect(response.headers.get("location"), label).toMatch(/error=unavailable$/);
      expect(cookieNamed(response, SESSION_COOKIE), label).toBeUndefined();
      // state が合わないうちは code を交換しない
      expect(google.requests.some((request) => request.url === TOKEN_URL), label).toBe(false);
    }
  });

  it("refuses an ID token that is not verified, is for another client or issuer, or is expired", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const cases: GoogleOptions[] = [
      { payload: claims({ email_verified: false }) },
      { payload: claims({ email_verified: "true" }) },
      { payload: claims({ aud: "other-client-id.apps.googleusercontent.com" }) },
      { payload: claims({ iss: "https://accounts.example.test" }) },
      { payload: claims({ exp: NOW_SECONDS - 3600 }) },
      { payload: claims({ email: undefined }) },
      { payload: claims({ sub: "" }) },
      { token: () => new Response(JSON.stringify({ access_token: "synthetic-access-token", id_token: idToken(claims(), other.privateKey) }), { status: 200, headers: { "content-type": "application/json" } }) },
      { token: () => new Response(JSON.stringify({ access_token: "synthetic-access-token" }), { status: 200, headers: { "content-type": "application/json" } }) },
      { token: () => new Response("{}", { status: 400 }) },
      { token: () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }) },
    ];
    for (const [index, option] of cases.entries()) {
      const { finished } = await signIn({ google: fakeGoogle(option) });
      expect(finished.headers.get("location"), `case ${index}`).toBe("/auth/login?next=%2Fsettings&error=unavailable");
      expect(cookieNamed(finished, SESSION_COOKIE), `case ${index}`).toBeUndefined();
    }
  });

  it("returns to the path kept in the cookie, never to one from the callback URL", async () => {
    const { auth } = provider();
    const started = await startLogin(auth, "/account");
    const params = new URLSearchParams({ state: started.state, code: CODE, next: "https://attacker.example.test/" });
    const response = await auth.completeLogin(
      new Request(`${ORIGIN}/auth/callback?${params.toString()}`, { headers: { cookie: `${LOGIN_COOKIE}=${started.cookie}` } }),
    );
    expect(response.headers.get("location")).toBe("/account");
  });
});

describe("getSession", () => {
  it("reads only a cookie this server signed, while it lasts and the address is still listed", async () => {
    const { auth, session: value, started } = await signIn();
    const [body, mac] = value.split(".") as [string, string];

    expect(await auth.getSession({ headers: new Headers() })).toBeNull();
    expect(await auth.getSession(session(""))).toBeNull();
    expect(await auth.getSession(session(body))).toBeNull();
    expect(await auth.getSession(session(`${body}.${mac.slice(0, -1)}x`))).toBeNull();
    // 中身を書き換えた cookie（別の人になりすます）
    const forged = Buffer.from(JSON.stringify({ u: "999", m: ALLOWED, e: NOW + 60_000 })).toString("base64url");
    expect(await auth.getSession(session(`${forged}.${mac}`))).toBeNull();
    // ログインの途中の cookie はセッションにならない（鍵が別）
    expect(await auth.getSession(session(started.cookie))).toBeNull();

    // 期限切れ
    const later = createGoogleAuthProvider({ env: () => environment(), now: () => NOW + (SESSION_TTL_SECONDS + 1) * 1000 });
    expect(await later.getSession(session(value))).toBeNull();
    // 許可リストから外したあと（cookie は有効なまま）
    const removed = createGoogleAuthProvider({ env: () => environment({ EDITOR_GOOGLE_ALLOWED_EMAILS: ALLOWED_SECOND }), now: () => NOW });
    expect(await removed.getSession(session(value))).toBeNull();
    // 同じ設定なら読める
    const same = createGoogleAuthProvider({ env: () => environment(), now: () => NOW });
    expect((await same.getSession(session(value)))?.userId).toBe(SUBJECT);
  });
});

describe("logout", () => {
  it("clears the session cookie and goes back to the login screen", async () => {
    const { auth, session: value } = await signIn();
    const response = await auth.logout(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/login");
    const cleared = cookieNamed(response, SESSION_COOKIE) ?? "";
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).not.toContain(value);
  });
});

describe("what gets logged", () => {
  it("writes only the step of a failure: no token, no secret, no address", async () => {
    const { finished } = await signIn({ google: fakeGoogle({ payload: claims({ email: OUTSIDE, sub: SUBJECT }) }) });
    expect(finished.headers.get("location")).toContain("error=forbidden");
    const lines = JSON.stringify(logged);
    for (const secret of [OUTSIDE, ALLOWED, CLIENT_SECRET, CODE, "synthetic-access-token", "synthetic-random-2"]) {
      expect(lines, secret).not.toContain(secret);
    }
  });
});
