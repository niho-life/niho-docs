// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, CONTRACT_VERSION } from "@niho/editor-publish-contract";
import { createReferenceServer, type ReferenceRequest, type ReferenceResponse } from "@niho/editor-publish-contract/test-support";
import { createPublicApi } from "./handler";
import { buildFixture, caller, serverScenarios, type Fixture, type Outcome, type WorldServer } from "./testing/contract-scenarios";
import { generateWorld, randomRequest, type RandomRequest, type RandomWorld } from "./testing/random-world";
import { createRng } from "./testing/synthetic";
import { worldFaces, worldSource } from "./testing/world-source";

/**
 * 契約の差分テスト：production の handler（＋メモリの PublicApiSource）と、契約の参照モデル（テスト専用）を同じ world と要求で動かし、
 * status・header・本文がバイト単位で同じことを確かめる。cursor の文字列だけは違ってよい（不透明。参照モデルは位置をそのまま書く）ので、
 * 次のページがある一覧は cursor と ETag を伏せて比べ、cursor で全件をたどった項目を別に比べる。
 */

interface ContractCase {
  readonly id: string;
  readonly layer: "server" | "validator" | "markdown";
  readonly expected: Outcome;
}

const contractDir = path.dirname(createRequire(import.meta.url).resolve("@niho/editor-publish-contract/package.json"));
const cases = JSON.parse(readFileSync(path.join(contractDir, "v1/cases.json"), "utf8")) as { contractVersion: string; cases: readonly ContractCase[] };
const serverCases = cases.cases.filter((testCase) => testCase.layer === "server");

const productionServer: WorldServer = (world, request) =>
  createPublicApi({ source: worldSource(world), faces: worldFaces(world), clock: { now: () => world.now } }).handle(request);
const referenceServer: WorldServer = (world, request) => createReferenceServer(world).handle(request);

/** 本文の nextCursor が文字列（次のページがある一覧）。 */
function hasNextCursor(response: ReferenceResponse): boolean {
  if (response.body === null) return false;
  const parsed = JSON.parse(response.body) as { nextCursor?: unknown };
  return typeof parsed.nextCursor === "string";
}

/** 次のページがある一覧だけ、cursor と ETag を伏せる（それ以外はそのまま）。 */
function comparable(response: ReferenceResponse, paged: boolean): ReferenceResponse {
  if (!paged) return response;
  const headers = { ...response.headers };
  if (headers.etag !== undefined) headers.etag = "<paged>";
  let body = response.body;
  if (body !== null) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.nextCursor === "string") parsed.nextCursor = "<cursor>";
    body = canonicalJson(parsed);
  }
  return { status: response.status, headers, body };
}

describe("contract cases (v1/cases.json) against the production handler", () => {
  let fixture: Fixture;
  const mismatches: string[] = [];
  let compared = 0;

  /** production で答え、同じ要求を参照モデルにも渡して突き合わせる（production が出した cursor を持つ要求は除く）。 */
  const paired: WorldServer = async (world, request) => {
    const production = await productionServer(world, request);
    if (!/[?&]cursor=v1\./.test(request.url)) {
      const reference = await referenceServer(world, request);
      const paged = hasNextCursor(production) || hasNextCursor(reference);
      compared += 1;
      if (JSON.stringify(comparable(production, paged)) !== JSON.stringify(comparable(reference, paged))) {
        mismatches.push(`${request.method} ${request.url}`);
      }
    }
    return production;
  };
  const scenarios = serverScenarios(caller(paired));

  beforeAll(async () => {
    fixture = await buildFixture();
  });

  it("covers exactly the server scenarios of the contract", () => {
    expect(cases.contractVersion).toBe(CONTRACT_VERSION);
    expect(serverCases.map((testCase) => testCase.id).sort()).toEqual(Object.keys(scenarios).sort());
  });

  for (const testCase of serverCases) {
    it(`server: ${testCase.id}`, async () => {
      const outcome = await scenarios[testCase.id]?.(fixture);
      expect(outcome).toEqual(testCase.expected);
    });
  }

  it("answered every scenario request exactly like the reference model", () => {
    expect(compared).toBeGreaterThan(100);
    expect(mismatches).toEqual([]);
  });
});

// --- 差分の性質テスト -----------------------------------------------------------------------------

const WORLDS = 400;
const REQUESTS_PER_WORLD = 60;

async function respond(server: WorldServer, generated: RandomWorld, request: RandomRequest, requestId: string): Promise<{
  response: ReferenceResponse;
  paged: boolean;
}> {
  const { world } = generated;
  const base: ReferenceRequest = { method: request.method, url: request.url, headers: request.headers, requestId };
  // その server が同じ要求の GET に返す今の ETag と、次のページの有無
  const plain = await server(world, { ...base, method: "GET" });
  const current = plain.headers.etag ?? "\"none\"";
  const tags: Record<RandomRequest["ifNoneMatch"], string | null> = {
    none: null,
    star: "*",
    stale: `"${"0".repeat(64)}"`,
    malformed: "not-an-etag",
    current,
    "weak-current": `W/${current}`,
    "list-current": `"stale", ${current}`,
  };
  const tag = tags[request.ifNoneMatch];
  const response = await server(world, tag === null ? base : { ...base, headers: { ...request.headers, "if-none-match": tag } });
  return { response, paged: hasNextCursor(plain) };
}

describe("differential properties: production === reference model", () => {
  it(`answers ${WORLDS} random worlds × ${REQUESTS_PER_WORLD} requests byte for byte`, async () => {
    let requests = 0;
    const statuses = new Map<number, number>();
    for (let seed = 1; seed <= WORLDS; seed += 1) {
      const generated = await generateWorld(seed);
      const rng = createRng(seed * 7919);
      for (let index = 0; index < REQUESTS_PER_WORLD; index += 1) {
        const request = randomRequest(rng, generated);
        const requestId = `req_diff_${seed}_${index}`;
        const production = await respond(productionServer, generated, request, requestId);
        const reference = await respond(referenceServer, generated, request, requestId);
        const context = `seed ${seed} #${index} ${request.method} ${request.url} inm=${request.ifNoneMatch}`;
        expect(production.paged, context).toBe(reference.paged);
        expect(comparable(production.response, production.paged), context).toEqual(comparable(reference.response, reference.paged));
        // header の並びも同じ（HEAD と GET の header の比較は JSON の文字列で行われる）
        expect(Object.keys(production.response.headers), context).toEqual(Object.keys(reference.response.headers));
        const text = JSON.stringify(production.response);
        for (const secret of generated.secrets) expect(text.includes(secret), context).toBe(false);
        statuses.set(production.response.status, (statuses.get(production.response.status) ?? 0) + 1);
        requests += 1;
      }
    }
    expect(requests).toBe(WORLDS * REQUESTS_PER_WORLD);
    // 合成の要求が全ての分岐に届いている
    for (const status of [200, 304, 400, 401, 404, 410, 503]) expect(statuses.get(status) ?? 0, `status ${status}`).toBeGreaterThan(0);
  }, 120_000);

  it("walks every list with small pages and gets the same items, pages and order as the reference", async () => {
    let walks = 0;
    for (let seed = 1; seed <= WORLDS; seed += 1) {
      const generated = await generateWorld(seed);
      for (const credential of generated.credentials) {
        for (const include of [false, true]) {
          for (const limit of [1, 2, 3]) {
            const walk = async (server: WorldServer) => {
              const pages: unknown[][] = [];
              let cursor: string | null = null;
              let last: ReferenceResponse | null = null;
              do {
                const query: string = [`limit=${limit}`, ...(include ? ["include=unlisted"] : []), ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join("&");
                last = await server(generated.world, {
                  method: "GET",
                  url: `/v1/${credential.reads}/published.json?${query}`,
                  headers: { authorization: `Bearer ${credential.value}` },
                  requestId: "req_walk",
                });
                if (last.status !== 200 || last.body === null) break;
                const body = JSON.parse(last.body) as { items: unknown[]; nextCursor: string | null };
                pages.push(body.items);
                cursor = body.nextCursor;
              } while (cursor !== null && pages.length < 100);
              return { pages, status: last?.status, error: last?.status === 200 ? null : last?.body };
            };
            const production = await walk(productionServer);
            const reference = await walk(referenceServer);
            expect(production, `seed ${seed} ${credential.reads} include=${include} limit=${limit}`).toEqual(reference);
            walks += 1;
          }
        }
      }
    }
    expect(walks).toBeGreaterThan(WORLDS * 6);
  }, 120_000);
});

