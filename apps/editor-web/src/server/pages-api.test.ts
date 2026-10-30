import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InvalidPageCursorError, type CreatePageInput, type Page, type PageChunk, type PageChunkOptions, type PagePatch, type PageSummary } from "@niho/editor-store";
import { stubAuthProvider } from "../auth/stub";
import type { AuthProvider } from "../auth/types";
import { MAX_BODY_BYTES } from "./http";
import { createPage, getPage, listPages, patchPage, type PagesApiDeps } from "./pages-api";

const ORIGIN = "http://editor.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** owner ごとに分けた、メモリの中だけの合成の store（EditorStore と同じ約束: 該当なしは null）。 */
function memoryStore() {
  const rows = new Map<string, Page & { owner: string; deleted: boolean }>();
  const visible = (owner: string, id: string) => {
    const row = rows.get(id);
    return row && row.owner === owner && !row.deleted ? row : null;
  };
  const strip = (row: Page & { owner: string; deleted: boolean }): Page => {
    const page: Partial<typeof row> = { ...row };
    delete page.owner;
    delete page.deleted;
    return page as Page;
  };
  return {
    rows,
    async createPage(owner: string, input: CreatePageInput = {}): Promise<Page> {
      const now = new Date().toISOString();
      const page = { id: randomUUID(), kind: input.kind ?? "note", title: input.title ?? "", lang: input.lang ?? "ja", blocks: input.blocks ?? [], cover: null, lead: null, parent: null, recipe: null, stepStatus: null, createdAt: now, updatedAt: now } as Page;
      rows.set(page.id, { ...page, owner, deleted: false });
      return page;
    },
    /** cursor は前の区切りの最後の id（知らない id は読めない cursor）。 */
    async listPageChunk(owner: string, options: PageChunkOptions = {}): Promise<PageChunk> {
      const sorted = [...rows.values()]
        .filter((row) => row.owner === owner && !row.deleted)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      let start = 0;
      if (options.cursor !== undefined && options.cursor !== null) {
        start = sorted.findIndex((row) => row.id === options.cursor) + 1;
        if (start === 0) throw new InvalidPageCursorError();
      }
      const limit = options.limit ?? 100;
      const pages: PageSummary[] = sorted.slice(start, start + limit).map(({ id, kind, title, lang, parent, stepStatus, createdAt, updatedAt }) => ({ id, kind, title, lang, parent, stepStatus, createdAt, updatedAt }));
      return { pages, next: start + limit < sorted.length ? (pages.at(-1)?.id ?? null) : null };
    },
    async getPage(owner: string, id: string): Promise<Page | null> {
      if (!UUID.test(id)) return null;
      const row = visible(owner, id);
      return row ? strip(row) : null;
    },
    async savePage(owner: string, id: string, patch: PagePatch): Promise<Page | null> {
      if (!UUID.test(id)) return null;
      const row = visible(owner, id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return strip(row);
    },
  };
}

function authAs(userId: string | null): AuthProvider {
  return { ...stubAuthProvider, getSession: async () => (userId ? { userId, mode: "stub" } : null) };
}

function deps(userId: string | null, store: ReturnType<typeof memoryStore> | null): PagesApiDeps {
  return { auth: () => authAs(userId), store: () => store, env: {} };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

/** date 以外の header を並べたもの（同じ応答かどうかを比べる）。 */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

describe("/api/pages", () => {
  it("creates an empty page, saves it, and reads it back", async () => {
    const store = memoryStore();
    const created = await createPage(request("POST", "/api/pages", {}), deps("user-a", store));
    expect(created.status).toBe(201);
    const { page } = (await created.json()) as { page: Page };
    expect(page.title).toBe("");
    expect(page.blocks).toEqual([]);

    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    const saved = await patchPage(request("PATCH", `/api/pages/${page.id}`, { title: "合成", blocks }), page.id, deps("user-a", store));
    expect(saved.status).toBe(200);

    const read = await getPage(request("GET", `/api/pages/${page.id}`), page.id, deps("user-a", store));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { page: Page }).page).toMatchObject({ id: page.id, title: "合成", blocks });

    const list = await listPages(request("GET", "/api/pages"), deps("user-a", store));
    expect(((await list.json()) as { pages: PageSummary[] }).pages.map((item) => item.id)).toEqual([page.id]);
  });

  it("stores a body as the limited AST: drops display-only attributes and refuses HTML, script and unsafe links with the same 400", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", {});
    const patch = (body: unknown) => patchPage(request("PATCH", `/api/pages/${page.id}`, body), page.id, deps("user-a", store));
    const link = { type: "link", attrs: { href: "https://niho.life/", target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null } };

    const saved = await patch({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "NIHO", marks: [link] }] }] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { page: Page }).page.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "NIHO", marks: [{ type: "link", attrs: { href: "https://niho.life/" } }] }] },
    ]);

    const refused = [
      [{ type: "script", content: [{ type: "text", text: "alert(1)" }] }],
      [{ type: "html", html: "<img src=x onerror=alert(1)>" }],
      [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
      [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "x" }] }],
      [{ type: "image", attrs: { assetId: "not-a-uuid", src: "https://example.com/a.png" } }],
    ];
    for (const blocks of refused) {
      const response = await patch({ blocks });
      expect(response.status, JSON.stringify(blocks)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
  });

  it("answers the same 404 for another owner's page, an unknown id, a malformed id, and a deleted page", async () => {
    const store = memoryStore();
    const theirs = await store.createPage("user-b", { title: "theirs" });
    const removed = await store.createPage("user-a", { title: "removed" });
    store.rows.get(removed.id)!.deleted = true;
    const ids = [theirs.id, randomUUID(), "not-a-uuid", "../../etc", removed.id];

    const reads = await Promise.all(ids.map(async (id) => snapshot(await getPage(request("GET", `/api/pages/${encodeURIComponent(id)}`), id, deps("user-a", store)))));
    for (const read of reads) expect(read).toEqual(reads[0]);
    expect(reads[0]?.status).toBe(404);
    expect(reads[0]?.body).toBe('{"error":"not_found"}');

    const writes = await Promise.all(ids.map(async (id) => snapshot(await patchPage(request("PATCH", `/api/pages/x`, { title: "overwrite" }), id, deps("user-a", store)))));
    for (const write of writes) expect(write).toEqual(reads[0]);
    expect(store.rows.get(theirs.id)?.title).toBe("theirs");
  });

  it("answers 401 without a session on every route", async () => {
    const store = memoryStore();
    const id = randomUUID();
    const responses = [
      await listPages(request("GET", "/api/pages"), deps(null, store)),
      await createPage(request("POST", "/api/pages", {}), deps(null, store)),
      await getPage(request("GET", `/api/pages/${id}`), id, deps(null, store)),
      await patchPage(request("PATCH", `/api/pages/${id}`, { title: "x" }), id, deps(null, store)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    expect(store.rows.size).toBe(0);
  });

  it("answers 403 to writes from another origin or without an Origin", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a");
    for (const origin of ["https://evil.example", "null", ""]) {
      const headers = { origin };
      expect((await createPage(request("POST", "/api/pages", {}, headers), deps("user-a", store))).status).toBe(403);
      expect((await patchPage(request("PATCH", `/api/pages/${page.id}`, { title: "x" }, headers), page.id, deps("user-a", store))).status).toBe(403);
    }
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(page.id)?.title).toBe("");
  });

  it("answers 413 above 1 MiB and 400 to bodies that are not JSON or not the right shape", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a");
    const big = JSON.stringify({ title: "x", blocks: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(MAX_BODY_BYTES) }] }] });
    expect((await patchPage(request("PATCH", `/api/pages/${page.id}`, big), page.id, deps("user-a", store))).status).toBe(413);
    expect((await createPage(request("POST", "/api/pages", big), deps("user-a", store))).status).toBe(413);

    const bad: Array<[unknown, Record<string, string>?]> = [
      ["{", undefined],
      ["title=x", { "content-type": "application/x-www-form-urlencoded" }],
      [{ title: "x" }, { "content-type": "text/plain" }],
      [{}, undefined],
      [{ blocks: "<p>x</p>" }, undefined],
      [{ blocks: { type: "doc" } }, undefined],
      [{ lang: "fr" }, undefined],
      [{ owner: "user-b" }, undefined],
    ];
    for (const [body, headers] of bad) {
      const response = await patchPage(request("PATCH", `/api/pages/${page.id}`, body, headers), page.id, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
  });

  it("pages through the list with limit and cursor, each page exactly once", async () => {
    const store = memoryStore();
    const created: string[] = [];
    for (let index = 0; index < 5; index++) created.push((await store.createPage("user-a", { title: `p${index}` })).id);
    await store.createPage("user-b", { title: "theirs" });

    const first = (await (await listPages(request("GET", "/api/pages"), deps("user-a", store))).json()) as PageChunk;
    expect(first.pages).toHaveLength(5);
    expect(first.next).toBeNull();
    expect(Object.keys(first.pages[0]!).sort()).toEqual(["createdAt", "id", "kind", "lang", "parent", "stepStatus", "title", "updatedAt"]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await listPages(request("GET", `/api/pages${query}`), deps("user-a", store));
      expect(response.status).toBe(200);
      const chunk = (await response.json()) as PageChunk;
      expect(chunk.pages.length).toBeLessThanOrEqual(2);
      seen.push(...chunk.pages.map((page) => page.id));
      cursor = chunk.next;
      calls++;
    } while (cursor !== null && calls < 10);
    expect(calls).toBe(3);
    expect(seen.sort()).toEqual([...created].sort());
  });

  it("answers 400 to an unreadable limit or cursor", async () => {
    const store = memoryStore();
    await store.createPage("user-a");
    for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=abc", "limit=", "limit=01", "limit=501", "limit=10000", "cursor=", `cursor=${"x".repeat(129)}`, "cursor=not-a-cursor"]) {
      const response = await listPages(request("GET", `/api/pages?${query}`), deps("user-a", store));
      expect(response.status, query).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect((await listPages(request("GET", "/api/pages?limit=500"), deps("user-a", store))).status).toBe(200);
    expect((await listPages(request("GET", "/api/pages?limit=1"), deps("user-a", store))).status).toBe(200);
  });

  it("answers 503 without a database and 500 without internal details when the store fails", async () => {
    const id = randomUUID();
    expect((await listPages(request("GET", "/api/pages"), deps("user-a", null))).status).toBe(503);
    expect((await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", null))).status).toBe(503);

    const store = memoryStore();
    store.getPage = async () => {
      throw Object.assign(new Error('relation "pages" does not exist at SELECT secret_column FROM pages'), { code: "42P01" });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", store));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"internal"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("SELECT");
    log.mockRestore();
  });

  it("marks every API response noindex, nofollow and uncacheable", async () => {
    const store = memoryStore();
    const id = randomUUID();
    const responses = [
      await listPages(request("GET", "/api/pages"), deps("user-a", store)),
      await createPage(request("POST", "/api/pages", {}), deps("user-a", store)),
      await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", store)),
      await patchPage(request("PATCH", `/api/pages/${id}`, "{"), id, deps("user-a", store)),
      await listPages(request("GET", "/api/pages"), deps(null, store)),
      await listPages(request("GET", "/api/pages"), deps("user-a", null)),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});
