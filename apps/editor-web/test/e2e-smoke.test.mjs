// 起動した editor-web（`next dev`・EDITOR_AUTH_MODE=stub）に対して、ページを作る → 書く → 読み直すと残る、一覧と枠、を確かめる。
// そのあと EDITOR_AUTH_MODE=niho で起動し直し、未ログインの画面がログインへ戻り先つきで移ることを確かめる（同じ dir の `next dev` は同時に 1 つ）。
// 前提: DATABASE_URL の DB に packages/editor-store の migration を適用済み（README）。合成の値だけを書き、終わりに消す。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the e2e smoke test (apply packages/editor-store migrations first)");

const appDir = fileURLToPath(new URL("..", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const OTHER_OWNER = "synthetic-other-owner";
const STUB_OWNER = "stub-user";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** `next dev` を起動し、`/api/pages` が readyStatus を返すまで待つ。止めるときは stop()。 */
async function startDev(mode, readyStatus) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, EDITOR_AUTH_MODE: mode, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.NODE_ENV;
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));
  const stop = async () => {
    if (!server.pid || server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // 既に終了している
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // 既に終了している
      }
    }, 10_000);
    await exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/pages`);
      if (response.status === readyStatus) break;
    } catch {
      // まだ起動中
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`next dev did not become ready:\n${serverLog.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { base, stop };
}

describe("editor-web e2e (stub, next dev)", () => {
  let base;
  let dev;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const createdIds = [];

  const write = (method, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  before(async () => {
    dev = await startDev("stub", 200);
    base = dev.base;
  });

  after(async () => {
    if (createdIds.length > 0) await pool.query("DELETE FROM pages WHERE id = ANY($1::uuid[])", [createdIds]);
    await pool.end();
    await dev?.stop();
  });

  it("creates a page, writes to it, and still has it after reloading", async () => {
    const created = await write("POST", "/api/pages", {});
    assert.equal(created.status, 201);
    const { page } = await created.json();
    createdIds.push(page.id);
    assert.equal(page.title, "");

    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文 e2e" }] }];
    const saved = await write("PATCH", `/api/pages/${page.id}`, { title: "合成の題名 e2e", blocks });
    assert.equal(saved.status, 200);

    const read = await fetch(`${base}/api/pages/${page.id}`);
    assert.equal(read.status, 200);
    const again = (await read.json()).page;
    assert.equal(again.title, "合成の題名 e2e");
    assert.deepEqual(again.blocks, blocks);

    const list = (await (await fetch(`${base}/api/pages`)).json()).pages;
    assert.equal(list[0].id, page.id, "the page just saved is first in the list");

    // 再読み込み: ページの HTML に保存した題名と本文が入っている
    const html = await (await fetch(`${base}/p/${page.id}`)).text();
    assert.match(html, /合成の題名 e2e/);
    assert.match(html, /合成の本文 e2e/);
    assert.match(html, /data-auth-mode="stub"/, "stub mode is shown on the page");
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /aria-label="ページの一覧"/);
    assert.match(home, /合成の題名 e2e/, "the saved page is in the list");
  });

  it("renders / as the shell with the page list", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const html = await response.text();
    assert.match(html, /aria-label="ページの一覧"/);
    assert.match(html, /aria-label="新しいページ"/);
    assert.match(html, /開発ユーザー/, "the me row shows the stub profile");
    for (const path of ["/p/new", "/p/new?from=recording", "/destinations", "/account", "/settings"]) {
      const screen = await fetch(`${base}${path}`);
      assert.equal(screen.status, 200, path);
      assert.match(await screen.text(), /aria-label="ページの一覧"/, path);
    }
  });

  it("sends a signed-in visitor of /auth/login back to a safe return path, and guards logout", async () => {
    for (const [query, expected] of [
      ["", "/"],
      ["?next=%2Fsettings", "/settings"],
      ["?next=%2F%2Fevil.example", "/"],
      ["?next=https%3A%2F%2Fevil.example%2F", "/"],
    ]) {
      const response = await fetch(`${base}/auth/login${query}`, { redirect: "manual" });
      assert.ok([303, 307].includes(response.status), `/auth/login${query} → ${response.status}`);
      const location = new URL(response.headers.get("location") ?? "", base);
      assert.equal(location.origin, base);
      assert.equal(`${location.pathname}${location.search}`, expected);
    }
    const start = await fetch(`${base}/auth/login/start?next=%2Fp%2Fnew`, { redirect: "manual" });
    assert.equal(start.status, 303);
    assert.equal(start.headers.get("location"), "/p/new");
    assert.equal(start.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: "https://evil.example" }, redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${base}/auth/logout`, { redirect: "manual" })).status, 405);
    const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: base }, redirect: "manual" });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/auth/login");
  });

  it("renders only the first chunk of 500 pages on / within a second, and pages through the rest by cursor", async () => {
    // 合成の 500 ページ（他のテストのページより新しい時刻。i が小さいほど新しい）
    const inserted = await pool.query(
      `INSERT INTO pages (owner, title, created_at, updated_at)
       SELECT $1, 'synthetic list ' || lpad(i::text, 3, '0'), t, t
         FROM generate_series(0, 499) AS i,
              LATERAL (SELECT clock_timestamp() + interval '1 hour' - i * interval '1 second' AS t) AS at
       RETURNING id`,
      [STUB_OWNER],
    );
    const syntheticIds = inserted.rows.map((row) => row.id);
    createdIds.push(...syntheticIds);

    await (await fetch(`${base}/`)).text();
    const started = performance.now();
    const response = await fetch(`${base}/`);
    const html = await response.text();
    const elapsed = performance.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 1000, `GET / took ${Math.round(elapsed)} ms`);
    assert.match(html, /synthetic list 000/);
    assert.match(html, /synthetic list 099/);
    assert.doesNotMatch(html, /synthetic list 100/, "only the first chunk is rendered");
    assert.doesNotMatch(html, /synthetic list 149/, "the 150th page is not rendered");

    const total = await pool.query("SELECT count(*)::int AS n FROM pages WHERE owner = $1 AND deleted_at IS NULL", [STUB_OWNER]);
    const ids = [];
    let cursor = null;
    let requests = 0;
    do {
      const query = cursor === null ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
      const chunk = await fetch(`${base}/api/pages${query}`);
      assert.equal(chunk.status, 200);
      const body = await chunk.json();
      assert.ok(body.pages.length <= 100);
      ids.push(...body.pages.map((page) => page.id));
      cursor = body.next;
      requests++;
      assert.ok(requests <= 20, "the cursor must advance");
    } while (cursor !== null);
    assert.equal(new Set(ids).size, ids.length, "no page twice");
    assert.equal(ids.length, total.rows[0].n, "every page once");
    assert.deepEqual(ids.slice(0, 500), syntheticIds, "newest first");
    assert.equal((await fetch(`${base}/api/pages?cursor=not-a-cursor`)).status, 400);
    assert.equal((await fetch(`${base}/api/pages?limit=0`)).status, 400);
  });

  it("answers the same 404 for another owner's page, an unknown id, and a malformed id", async () => {
    const other = await pool.query("INSERT INTO pages (owner, title) VALUES ($1, 'synthetic other') RETURNING id", [OTHER_OWNER]);
    const otherId = other.rows[0].id;
    createdIds.push(otherId);
    const ids = [otherId, randomUUID(), "not-a-uuid"];

    const snapshot = async (response) => ({
      status: response.status,
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
      body: await response.text(),
    });

    // API: 本文・header（date を除く）まで同じ
    for (const [label, call] of [
      ["GET /api/pages/{id}", (id) => fetch(`${base}/api/pages/${id}`)],
      ["PATCH /api/pages/{id}", (id) => write("PATCH", `/api/pages/${id}`, { title: "overwrite" })],
    ]) {
      const results = [];
      for (const id of ids) results.push(await snapshot(await call(id)));
      assert.equal(results[0].status, 404, label);
      assert.equal(results[0].body, '{"error":"not_found"}', label);
      for (const result of results.slice(1)) assert.deepEqual(result, results[0], `${label} responses must be identical`);
    }

    // 画面: 同じ 404 の画面と同じ header。`next dev` の HTML は要求ごとの開発用の値（stack・時刻）を含むので、本文は中身で比べる
    // （`next dev` は CSS の Link header に読み込みごとの `?v=時刻` を付けるので、その値だけは外して比べる。
    // CSP の nonce も要求ごとに変わる乱数で、ページの存在を漏らさないので、値だけ外して比べる）
    const devStable = (headers) =>
      headers.map(([name, value]) => [name, value.replace(/\?v=\d+/g, "?v=").replace(/'nonce-[^']*'/g, "'nonce-'")]);
    const pages = [];
    for (const id of ids) pages.push(await snapshot(await fetch(`${base}/p/${id}`)));
    for (const result of pages) {
      assert.equal(result.status, 404);
      assert.deepEqual(devStable(result.headers), devStable(pages[0].headers), "page headers must be identical");
      assert.match(result.body, /ページが見つかりません/);
      assert.doesNotMatch(result.body, /synthetic other/);
    }
    const untouched = await pool.query("SELECT title FROM pages WHERE id = $1", [otherId]);
    assert.equal(untouched.rows[0].title, "synthetic other");
  });

  it("refuses cross-origin writes, oversized bodies, and malformed bodies", async () => {
    const created = await write("POST", "/api/pages", {});
    const { page } = await created.json();
    createdIds.push(page.id);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await write("POST", "/api/pages", {}, { origin: "https://evil.example" })).status, 403);
    const big = JSON.stringify({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(1024 * 1024) }] }] });
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, big)).status, 413);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, "{")).status, 400);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, "title=x", { "content-type": "text/plain" })).status, 400);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { blocks: "<p>html</p>" })).status, 400);
    const unchanged = (await (await fetch(`${base}/api/pages/${page.id}`)).json()).page;
    assert.equal(unchanged.title, "");
  });

  it("sends X-Robots-Tag: noindex, nofollow on every route and the robots meta on every page", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const home = await fetch(`${base}/`);
    const homeHtml = await home.text();
    const asset = homeHtml.match(/\/_next\/static\/[^"']+\.js/)?.[0];
    assert.ok(asset, "a static asset is referenced");
    const responses = {
      "GET /": home,
      "GET /p/{id}": await fetch(`${base}/p/${page.id}`),
      "GET /p/{bad} (404)": await fetch(`${base}/p/not-a-uuid`),
      "GET /missing (404)": await fetch(`${base}/no-such-route`),
      "GET /robots.txt": await fetch(`${base}/robots.txt`),
      "GET /_next/static": await fetch(`${base}${asset}`),
      "GET /api/pages": await fetch(`${base}/api/pages`),
      "POST /api/pages (403)": await write("POST", "/api/pages", {}, { origin: "https://evil.example" }),
      "GET /api/pages/{id}": await fetch(`${base}/api/pages/${page.id}`),
      "PATCH /api/pages/{id}": await write("PATCH", `/api/pages/${page.id}`, { title: "robots" }),
      "GET /api/pages/{bad} (404)": await fetch(`${base}/api/pages/not-a-uuid`),
      "DELETE /api/pages/{id} (405)": await fetch(`${base}/api/pages/${page.id}`, { method: "DELETE", headers: { origin: base } }),
    };
    for (const [label, response] of Object.entries(responses)) {
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", label);
    }
    for (const label of ["GET /p/{id}", "GET /p/{bad} (404)", "GET /missing (404)"]) {
      assert.match(await responses[label].text(), /<meta name="robots" content="noindex, nofollow"\/>/, label);
    }
    assert.match(homeHtml, /<meta name="robots" content="noindex, nofollow"\/>/);
    const robotsTxt = await responses["GET /robots.txt"].text();
    assert.doesNotMatch(robotsTxt, /disallow/i);
  });

  it("finds the page just saved by its body text, and never another owner's page (#35)", async () => {
    // 合成の語（他の行と当たらないよう要求ごとに変える）
    const token = `合成検索${randomUUID().slice(0, 8)}`;
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const blocks = [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `本文の ${token} の行` }] }] }] }];
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "合成の検索 e2e", blocks })).status, 200);
    const other = await pool.query("INSERT INTO pages (owner, title, blocks) VALUES ($1, $2, $3::jsonb) RETURNING id", [
      OTHER_OWNER,
      `他人の ${token}`,
      JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: `他人の本文 ${token}` }] }]),
    ]);
    createdIds.push(other.rows[0].id);

    const response = await fetch(`${base}/api/search?q=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    const { results } = await response.json();
    assert.deepEqual(results.map((hit) => hit.id), [page.id]);
    assert.deepEqual(Object.keys(results[0]).sort(), ["id", "kind", "snippet", "title", "updatedAt"]);
    assert.match(results[0].snippet, new RegExp(token));
    assert.doesNotMatch(JSON.stringify(results), /他人/);

    assert.deepEqual(await (await fetch(`${base}/api/search?q=`)).json(), { results: [] });
    assert.deepEqual(await (await fetch(`${base}/api/search?q=a%00b`)).json(), { results: [] }, "NUL is not sent to the database");
    assert.equal((await fetch(`${base}/api/search?q=${"a".repeat(101)}`)).status, 400);
    assert.equal((await fetch(`${base}/api/search?q=x&limit=0`)).status, 400);
  });
});

describe("editor-web e2e (niho until #19459, next dev)", () => {
  let base;
  let dev;

  before(async () => {
    dev = await startDev("niho", 401);
    base = dev.base;
  });

  after(async () => {
    await dev?.stop();
  });

  it("sends an unauthenticated visitor to /auth/login with the screen as next", async () => {
    const id = randomUUID();
    for (const [path, expected, headers] of [
      [`/p/${id}`, `/auth/login?next=%2Fp%2F${id}`, {}],
      ["/p/new?from=recording", "/auth/login?next=%2Fp%2Fnew%3Ffrom%3Drecording", {}],
      ["/settings", "/auth/login?next=%2Fsettings", { "x-editor-path": "//evil.example" }],
      ["/", "/auth/login", {}],
      ["/p/not-a-uuid", "/auth/login", {}],
    ]) {
      const response = await fetch(`${base}${path}`, { redirect: "manual", headers });
      assert.equal(response.status, 307, path);
      assert.equal(response.headers.get("location"), expected, path);
    }
  });

  it("comes back to the login screen with an error and keeps next while niho login is unavailable", async () => {
    const start = await fetch(`${base}/auth/login/start?next=%2Fsettings`, { redirect: "manual" });
    assert.equal(start.status, 303);
    assert.equal(start.headers.get("location"), "/auth/login?next=%2Fsettings&error=unavailable");
    const login = await fetch(`${base}/auth/login?next=%2Fsettings&error=unavailable`);
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.match(html, /NIHOでログイン/);
    assert.match(html, /role="alert"[^>]*>ログインできませんでした。もう一度お試しください。/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
    assert.doesNotMatch(html, /data-auth-mode="stub"/);
  });
});
