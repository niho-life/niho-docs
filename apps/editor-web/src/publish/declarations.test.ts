import { describe, expect, it } from "vitest";
import { FetchedDeclarations, type FetchLike } from "./declarations";

const URL_EXP = "https://experience.example.com/.well-known/niho-editor-destination.json";
const BODY = { schemaVersion: 1, id: "exp", label: "NIHO Experience" };

type Call = { url: string; init: RequestInit };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } });
}

/** 応答を順に返す fetch。呼ばれた URL と init を残す。 */
function scripted(responses: Array<Response | (() => Response) | Error>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch, calls };
}

function source(fetch: FetchLike, clock: { t: number }, extra: Partial<ConstructorParameters<typeof FetchedDeclarations>[0]> = {}) {
  return new FetchedDeclarations({ urls: { exp: URL_EXP }, fetch, now: () => clock.t, ...extra });
}

const headerOf = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

describe("面の宣言を読む（EDITOR_DESTINATION_DECLARATIONS）", () => {
  it("読んだ JSON を返し、短い時間はメモリから。過ぎたら ETag で確かめ直し、304 なら前の宣言", async () => {
    const clock = { t: 0 };
    const { fetch, calls } = scripted([json(BODY, { headers: { etag: '"v1"' } }), new Response(null, { status: 304 })]);
    const declarations = source(fetch, clock);
    expect(await declarations.get("exp")).toEqual(BODY);
    clock.t = 59_000;
    expect(await declarations.get("exp")).toEqual(BODY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    expect(headerOf(calls[0]!, "if-none-match")).toBeUndefined();
    clock.t = 61_000;
    expect(await declarations.get("exp")).toEqual(BODY);
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[1]!, "if-none-match")).toBe('"v1"');
  });

  it("URL の無い面・面でない handle は読まずに null", async () => {
    const { fetch, calls } = scripted([]);
    const declarations = source(fetch, { t: 0 });
    expect(await declarations.get("niho")).toBeNull();
    expect(await declarations.get("field-notes")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("同時に読むときは 1 本にまとめる", async () => {
    const { fetch, calls } = scripted([json(BODY)]);
    const declarations = source(fetch, { t: 0 });
    expect(await Promise.all([declarations.get("exp"), declarations.get("exp")])).toEqual([BODY, BODY]);
    expect(calls).toHaveLength(1);
  });

  it("返す値は複製（書き換えても次に返す宣言は変わらない）", async () => {
    const { fetch } = scripted([json(BODY)]);
    const declarations = source(fetch, { t: 0 });
    (await declarations.get("exp") as Record<string, unknown>).label = "changed";
    expect(await declarations.get("exp")).toEqual(BODY);
  });

  it("読めないもの（500・JSON でない・壊れた JSON・大きすぎる・通信の失敗）は null。しばらくは読みに行かない", async () => {
    const failures: Array<Response | Error> = [
      new Response("x", { status: 500 }),
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      json({ padding: "x".repeat(2048) }),
      new TypeError("fetch failed"),
    ];
    for (const failure of failures) {
      const clock = { t: 0 };
      const { fetch, calls } = scripted([failure, json(BODY)]);
      const declarations = source(fetch, clock, { maxBytes: 1024 });
      expect(await declarations.get("exp")).toBeNull();
      clock.t = 10_000;
      expect(await declarations.get("exp")).toBeNull();
      expect(calls).toHaveLength(1);
      clock.t = 16_000;
      expect(await declarations.get("exp")).toEqual(BODY);
    }
  });

  it("失敗したら前に読めた宣言も使わず、ETag も捨てて取り直す", async () => {
    const clock = { t: 0 };
    const { fetch, calls } = scripted([json(BODY, { headers: { etag: '"v1"' } }), new Response("x", { status: 503 }), json(BODY)]);
    const declarations = source(fetch, clock);
    expect(await declarations.get("exp")).toEqual(BODY);
    clock.t = 61_000;
    expect(await declarations.get("exp")).toBeNull();
    clock.t = 80_000;
    expect(await declarations.get("exp")).toEqual(BODY);
    expect(headerOf(calls[2]!, "if-none-match")).toBeUndefined();
  });

  it("redirect は同じ host の https へだけ追う（別の host・http・回数の上限は失敗）", async () => {
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const same = scripted([redirect("/v2/destination.json"), json(BODY)]);
    expect(await source(same.fetch, { t: 0 }).get("exp")).toEqual(BODY);
    expect(same.calls.map((call) => call.url)).toEqual([URL_EXP, "https://experience.example.com/v2/destination.json"]);

    for (const responses of [
      [redirect("https://other.example.com/destination.json")],
      [redirect("http://experience.example.com/destination.json")],
      [redirect("/a"), redirect("/b"), redirect("/c"), redirect("/d")],
    ]) {
      const { fetch, calls } = scripted([...responses]);
      expect(await source(fetch, { t: 0 }).get("exp")).toBeNull();
      expect(calls.every((call) => call.url.startsWith("https://experience.example.com/"))).toBe(true);
    }
  });

  it("時間の上限を過ぎたら null", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await source(fetch, { t: 0 }, { timeoutMs: 20 }).get("exp")).toBeNull();
  });
});
