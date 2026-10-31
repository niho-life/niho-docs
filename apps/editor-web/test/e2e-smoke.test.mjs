// 起動した editor-web（`next dev`・EDITOR_AUTH_MODE=stub）に対して、ページを作る → 書く → 読み直すと残る、一覧と枠、を確かめる。
// あわせて、古い revision の保存が 409 になること・版から戻せること・ゴミ箱へ入れて戻せることを確かめる。
// そのあと EDITOR_AUTH_MODE=niho で起動し直し、未ログインの画面がログインへ戻り先つきで移ること・共有リンク（/s/{token}）はログインなしで枠の外に開くことを確かめる（同じ dir の `next dev` は同時に 1 つ）。
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

    assert.equal(page.revision, 1);

    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文 e2e" }] }];
    const saved = await write("PATCH", `/api/pages/${page.id}`, { title: "合成の題名 e2e", blocks, baseRevision: page.revision });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).page.revision, 2);

    const read = await fetch(`${base}/api/pages/${page.id}`);
    assert.equal(read.status, 200);
    const again = (await read.json()).page;
    assert.equal(again.title, "合成の題名 e2e");
    assert.deepEqual(again.blocks, blocks);
    assert.equal(again.revision, 2);

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
      // 別の人のページの revision は 1。一致しても不一致でも 409 ではなく同じ 404
      ["PATCH /api/pages/{id}", (id) => write("PATCH", `/api/pages/${id}`, { title: "overwrite", baseRevision: 1 })],
      ["PATCH /api/pages/{id} (stale)", (id) => write("PATCH", `/api/pages/${id}`, { title: "overwrite", baseRevision: 99 })],
      ["DELETE /api/pages/{id}", (id) => fetch(`${base}/api/pages/${id}`, { method: "DELETE", headers: { origin: base } })],
      ["GET /api/pages/{id}/versions", (id) => fetch(`${base}/api/pages/${id}/versions`)],
      ["POST /api/pages/{id}/versions/1/restore", (id) => write("POST", `/api/pages/${id}/versions/1/restore`, { baseRevision: 99 })],
      ["POST /api/trash/{id}/restore", (id) => fetch(`${base}/api/trash/${id}/restore`, { method: "POST", headers: { origin: base } })],
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
    const untouched = await pool.query("SELECT title, revision, deleted_at FROM pages WHERE id = $1", [otherId]);
    assert.equal(untouched.rows[0].title, "synthetic other");
    assert.equal(untouched.rows[0].revision, 1);
    assert.equal(untouched.rows[0].deleted_at, null);
  });

  it("refuses cross-origin writes, oversized bodies, and malformed bodies", async () => {
    const created = await write("POST", "/api/pages", {});
    const { page } = await created.json();
    createdIds.push(page.id);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "x", baseRevision: 1 }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/pages/${page.id}`, { method: "DELETE", headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await write("POST", "/api/pages", {}, { origin: "https://evil.example" })).status, 403);
    const big = JSON.stringify({ baseRevision: 1, blocks: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(1024 * 1024) }] }] });
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, big)).status, 413);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, "{")).status, 400);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, "title=x", { "content-type": "text/plain" })).status, 400);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { blocks: "<p>html</p>", baseRevision: 1 })).status, 400);
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "no revision" })).status, 400, "baseRevision is required");
    const unchanged = (await (await fetch(`${base}/api/pages/${page.id}`)).json()).page;
    assert.equal(unchanged.title, "");
    assert.equal(unchanged.revision, 1);
  });

  it("sends X-Robots-Tag: noindex, nofollow on every route and the robots meta on every page", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const doomed = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(doomed.id);
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
      "PATCH /api/pages/{id}": await write("PATCH", `/api/pages/${page.id}`, { title: "robots", baseRevision: 1 }),
      "PATCH /api/pages/{id} (409)": await write("PATCH", `/api/pages/${page.id}`, { title: "robots", baseRevision: 1 }),
      "GET /api/pages/{bad} (404)": await fetch(`${base}/api/pages/not-a-uuid`),
      "PUT /api/pages/{id} (405)": await fetch(`${base}/api/pages/${page.id}`, { method: "PUT", headers: { origin: base } }),
      "GET /api/pages/{id}/versions": await fetch(`${base}/api/pages/${page.id}/versions`),
      "GET /api/pages/{id}/versions/1 (404)": await fetch(`${base}/api/pages/${page.id}/versions/1`),
      "DELETE /api/pages/{id} (204)": await fetch(`${base}/api/pages/${doomed.id}`, { method: "DELETE", headers: { origin: base } }),
      "GET /api/trash": await fetch(`${base}/api/trash`),
      "POST /api/trash/{id}/restore (204)": await fetch(`${base}/api/trash/${doomed.id}/restore`, { method: "POST", headers: { origin: base } }),
    };
    for (const [label, response] of Object.entries(responses)) {
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", label);
      const expected = label.match(/\((\d{3})\)$/)?.[1];
      if (expected) assert.equal(response.status, Number(expected), label);
    }
    for (const label of ["GET /p/{id}", "GET /p/{bad} (404)", "GET /missing (404)"]) {
      assert.match(await responses[label].text(), /<meta name="robots" content="noindex, nofollow"\/>/, label);
    }
    assert.match(homeHtml, /<meta name="robots" content="noindex, nofollow"\/>/);
    const robotsTxt = await responses["GET /robots.txt"].text();
    assert.doesNotMatch(robotsTxt, /disallow/i);
  });

  it("answers 409 with the latest page to a save from an old revision, and lets the client overwrite on purpose", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const paragraph = (text) => [{ type: "paragraph", content: [{ type: "text", text }] }];

    // 別の画面が先に保存する
    const elsewhere = await write("PATCH", `/api/pages/${page.id}`, { title: "別の画面", blocks: paragraph("別の画面の本文"), baseRevision: 1 });
    assert.equal(elsewhere.status, 200);
    const latest = (await elsewhere.json()).page;
    assert.equal(latest.revision, 2);

    // この画面は古い revision のまま保存する
    const stale = await write("PATCH", `/api/pages/${page.id}`, { title: "この画面", blocks: paragraph("この画面の本文"), baseRevision: 1 });
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error, "conflict");
    assert.equal(conflict.page.id, page.id);
    assert.equal(conflict.page.title, "別の画面");
    assert.deepEqual(conflict.page.blocks, paragraph("別の画面の本文"));
    assert.equal(conflict.page.revision, 2);
    assert.equal(conflict.page.updatedAt, latest.updatedAt);
    const kept = (await (await fetch(`${base}/api/pages/${page.id}`)).json()).page;
    assert.equal(kept.title, "別の画面", "the stale save wrote nothing");
    assert.equal(kept.revision, 2);

    // 「この内容で上書き」: 競合の応答の revision で送り直す。上書きされる本文は版に残る
    const overwrite = await write("PATCH", `/api/pages/${page.id}`, { title: "この画面", blocks: paragraph("この画面の本文"), baseRevision: conflict.page.revision, overwrite: true });
    assert.equal(overwrite.status, 200);
    assert.equal((await overwrite.json()).page.revision, 3);
    const versions = (await (await fetch(`${base}/api/pages/${page.id}/versions`)).json()).versions;
    assert.equal(versions[0].reason, "overwrite");
    const kept2 = (await (await fetch(`${base}/api/pages/${page.id}/versions/${versions[0].version}`)).json()).version;
    assert.deepEqual(kept2.blocks, paragraph("別の画面の本文"));
  });

  it("lists versions and restores one, keeping the body before the restore", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const paragraph = (text) => [{ type: "paragraph", content: [{ type: "text", text }] }];
    let revision = page.revision;
    for (const text of ["一版", "二版"]) {
      const response = await write("PATCH", `/api/pages/${page.id}`, { blocks: paragraph(text), baseRevision: revision });
      assert.equal(response.status, 200);
      revision = (await response.json()).page.revision;
    }
    // 空の本文は版にしない。1 回目の変更（一版 → 二版）の前の本文が版 1
    const versions = (await (await fetch(`${base}/api/pages/${page.id}/versions`)).json()).versions;
    assert.deepEqual(versions.map(({ version, reason, blockCount }) => ({ version, reason, blockCount })), [{ version: 1, reason: "autosave", blockCount: 1 }]);
    assert.equal("blocks" in versions[0], false);
    const one = (await (await fetch(`${base}/api/pages/${page.id}/versions/1`)).json()).version;
    assert.deepEqual(one.blocks, paragraph("一版"));
    assert.equal((await fetch(`${base}/api/pages/${page.id}/versions/0`)).status, 404);

    assert.equal((await write("POST", `/api/pages/${page.id}/versions/1/restore`, { baseRevision: revision - 1 })).status, 409);
    const restored = await write("POST", `/api/pages/${page.id}/versions/1/restore`, { baseRevision: revision });
    assert.equal(restored.status, 200);
    const after = (await restored.json()).page;
    assert.deepEqual(after.blocks, paragraph("一版"));
    assert.equal(after.revision, revision + 1);
    const latest = (await (await fetch(`${base}/api/pages/${page.id}/versions`)).json()).versions[0];
    assert.equal(latest.reason, "restore");
    assert.deepEqual((await (await fetch(`${base}/api/pages/${page.id}/versions/${latest.version}`)).json()).version.blocks, paragraph("二版"));
  });

  it("deletes a page to the trash, shows it there, and restores it to the list", async () => {
    const page = (await (await write("POST", "/api/pages", { title: "ゴミ箱 e2e" })).json()).page;
    createdIds.push(page.id);
    // 一覧は limit 件ずつ（既定 100）。先のテストの合成の 500 ページの後ろにあっても見つけるよう、cursor で最後まで読む
    const listIds = async () => {
      const ids = [];
      let cursor = null;
      do {
        const query = cursor === null ? "?limit=500" : `?limit=500&cursor=${encodeURIComponent(cursor)}`;
        const body = await (await fetch(`${base}/api/pages${query}`)).json();
        ids.push(...body.pages.map((item) => item.id));
        cursor = body.next;
      } while (cursor !== null);
      return ids;
    };
    assert.ok((await listIds()).includes(page.id));

    const deleted = await fetch(`${base}/api/pages/${page.id}`, { method: "DELETE", headers: { origin: base } });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.ok(!(await listIds()).includes(page.id));
    assert.equal((await fetch(`${base}/api/pages/${page.id}`)).status, 404);
    assert.equal((await fetch(`${base}/p/${page.id}`)).status, 404);

    const trash = (await (await fetch(`${base}/api/trash`)).json()).pages;
    const entry = trash.find((item) => item.id === page.id);
    assert.ok(entry, "the page is in the trash");
    assert.equal(entry.title, "ゴミ箱 e2e");
    assert.deepEqual(Object.keys(entry).sort(), ["deletedAt", "id", "kind", "title"]);
    assert.equal(trash[0].id, page.id, "newest deletion first");

    const restored = await fetch(`${base}/api/trash/${page.id}/restore`, { method: "POST", headers: { origin: base } });
    assert.equal(restored.status, 204);
    assert.ok((await listIds()).includes(page.id));
    assert.ok(!(await (await fetch(`${base}/api/trash`)).json()).pages.some((item) => item.id === page.id));
    assert.equal((await fetch(`${base}/api/trash/${page.id}/restore`, { method: "POST", headers: { origin: base } })).status, 404, "not in the trash any more");

    // 公開中のページは削除しない（0009 の形: NIHO への公開版 1 と、それを指す公開）
    await pool.query(
      "INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1, 1, 'niho', jsonb_build_object('id', $2::text, 'version', 1, 'dest', 'niho'))",
      [page.id, page.id],
    );
    await pool.query(
      `INSERT INTO publications (page_id, dest, handle, slug, range, extras_app, extras_news, extras_xp, version, published_at, updated_at)
       VALUES ($1, 'niho', 'niho', $2, 'live', false, false, false, 1, clock_timestamp(), clock_timestamp())`,
      [page.id, `e2e-${page.id}`],
    );
    try {
      const refused = await fetch(`${base}/api/pages/${page.id}`, { method: "DELETE", headers: { origin: base } });
      assert.equal(refused.status, 409);
      assert.equal(await refused.text(), '{"error":"published"}');
      assert.ok((await listIds()).includes(page.id));
    } finally {
      // 公開の行を消せば、after のページの削除で公開版も一緒に消える（公開版だけを消すことはできない）
      await pool.query("DELETE FROM publications WHERE page_id = $1", [page.id]);
    }
  });

  it("finds the page just saved by its body text, and never another owner's page (#35)", async () => {
    // 合成の語（他の行と当たらないよう要求ごとに変える）
    const token = `合成検索${randomUUID().slice(0, 8)}`;
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const blocks = [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `本文の ${token} の行` }] }] }] }];
    // 本文を保存するには、読んだ revision を baseRevision で送る（#58 の競合検知）
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "合成の検索 e2e", blocks, baseRevision: page.revision })).status, 200);
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

  // ---- リンクで共有・複製・書き出し（#34） ----

  const PRIVATE_SHARE = { status: "PRIVATE", publicId: null, url: null, updatedAt: null };
  const tokenOf = (share) => {
    assert.equal(share.status, "PUBLIC");
    assert.match(share.url, new RegExp(`^${base.replace(/[.]/g, "\\.")}/s/[A-Za-z0-9_-]{43}$`));
    return share.url.slice(`${base}/s/`.length);
  };
  /** Cookie も認証の header も付けない素の要求（ログインしていない人の開き方）。 */
  const anonymous = (path) => fetch(`${base}${path}`, { headers: {}, redirect: "manual" });
  const assertSharedHeaders = (response, label) => {
    // 全体の規則（Referrer-Policy: same-origin）と重ならず、値は 1 つだけ（2 つあれば "a, b" になる）
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", label);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", label);
    // `next dev` はページの Cache-Control を開発用の値に置き換える（本番の値は test/startup-guard.test.mjs で確かめる）
    assert.match(response.headers.get("cache-control") ?? "", /no-store|no-cache/, label);
  };

  it("shares the latest saved version at /s/{token} without signing in, and stops or rotates the link at once (#34)", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const first = [{ type: "paragraph", content: [{ type: "text", text: "合成の共有 最初の本文" }] }];
    // 本文を保存するには、読んだ revision を baseRevision で送る（#58 の競合検知）。応答の revision を次の保存に使う
    const firstSave = await write("PATCH", `/api/pages/${page.id}`, { title: "合成の共有 e2e", blocks: first, baseRevision: page.revision });
    assert.equal(firstSave.status, 200);
    const firstRevision = (await firstSave.json()).page.revision;
    assert.deepEqual((await (await fetch(`${base}/api/pages/${page.id}/share`)).json()).share, PRIVATE_SHARE);

    const enabled = await write("PUT", `/api/pages/${page.id}/share`);
    assert.equal(enabled.status, 200);
    const { share } = await enabled.json();
    const token = tokenOf(share);
    assert.deepEqual((await (await write("PUT", `/api/pages/${page.id}/share`)).json()).share, share, "starting again keeps the same link");
    assert.deepEqual((await (await fetch(`${base}/api/pages/${page.id}/share`)).json()).share, share);
    assert.equal((await write("PUT", `/api/pages/${page.id}/share`, undefined, { origin: "https://evil.example" })).status, 403);

    const shared = await anonymous(`/s/${token}`);
    assert.equal(shared.status, 200);
    assert.equal(shared.headers.get("set-cookie"), null);
    assertSharedHeaders(shared, "GET /s/{token}");
    const html = await shared.text();
    assert.match(html, /<h1>合成の共有 e2e<\/h1>/);
    assert.match(html, /合成の共有 最初の本文/);
    assert.match(html, /<meta name="referrer" content="no-referrer"\/>/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
    assert.match(html, /<title>共有されたページ<\/title>/);
    // 枠（app/(editor)）の外: 一覧・ヘッダーを出さない。CSP は他の画面と同じく src/proxy.ts の nonce つき
    assert.doesNotMatch(html, /aria-label="ページの一覧"/, "the shared page is drawn without the editor frame");
    const sharedNonce = /'nonce-([^']+)'/.exec(shared.headers.get("content-security-policy") ?? "")?.[1];
    assert.ok(sharedNonce, "the shared page carries a nonce-based CSP");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${sharedNonce}"`), `a <script> without this request's nonce: ${tag.slice(0, 80)}`);
    assert.doesNotMatch(html.match(/<head>[\s\S]*?<\/head>/)?.[0].replace(/<script[\s\S]*?<\/script>/g, "") ?? "", new RegExp(token), "the token is not in the title or metadata");

    // 共有中に本文を保存し直すと、次に開いたときは新しい保存版
    const second = [{ type: "paragraph", content: [{ type: "text", text: "合成の共有 直した本文" }] }];
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { blocks: second, baseRevision: firstRevision })).status, 200);
    const updated = await (await anonymous(`/s/${token}`)).text();
    assert.match(updated, /合成の共有 直した本文/);
    assert.doesNotMatch(updated, /合成の共有 最初の本文/);

    // 作り直すと古いリンクはすぐ 404、新しいリンクは 200
    const rotated = await write("POST", `/api/pages/${page.id}/share/rotate`);
    assert.equal(rotated.status, 200);
    const fresh = tokenOf((await rotated.json()).share);
    assert.notEqual(fresh, token);
    assert.equal((await anonymous(`/s/${token}`)).status, 404);
    assert.equal((await anonymous(`/s/${fresh}`)).status, 200);

    // 止めるとすぐ 404（もう一度止めても同じ）
    const stopped = await write("DELETE", `/api/pages/${page.id}/share`);
    assert.equal(stopped.status, 200);
    assert.deepEqual((await stopped.json()).share, PRIVATE_SHARE);
    assert.deepEqual((await (await write("DELETE", `/api/pages/${page.id}/share`)).json()).share, PRIVATE_SHARE);

    // 止めた・作り直す前・形の違う・知らない token はどれも同じ 404（header・画面とも）
    const snapshot = async (response) => ({
      status: response.status,
      // CSP の nonce は要求ごとに変わる乱数で、ページの存在を漏らさないので、値だけ外して比べる（#61）
      headers: [...response.headers.entries()]
        .filter(([name]) => name !== "date")
        .map(([name, value]) => [name, value.replace(/\?v=\d+/g, "?v=").replace(/'nonce-[^']*'/g, "'nonce-'")])
        .sort(),
      body: await response.text(),
    });
    const missing = [];
    for (const candidate of [fresh, token, "not-a-token", "A".repeat(43)]) missing.push(await snapshot(await anonymous(`/s/${candidate}`)));
    for (const result of missing) {
      assert.equal(result.status, 404);
      assert.deepEqual(result.headers, missing[0].headers, "404 headers must be identical");
      assert.match(result.body, /ページが見つかりません/);
      assert.doesNotMatch(result.body, /合成の共有/);
    }
    assertSharedHeaders(await anonymous(`/s/${fresh}`), "GET /s/{stopped} (404)");
  });

  it("answers the same 404 for another owner's page on every page action, and changes nothing (#34)", async () => {
    const other = await pool.query("INSERT INTO pages (owner, title) VALUES ($1, 'synthetic other share') RETURNING id", [OTHER_OWNER]);
    const otherId = other.rows[0].id;
    createdIds.push(otherId);
    const otherToken = "S".repeat(43);
    await pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, $3)", [otherId, OTHER_OWNER, otherToken]);
    const before = (await pool.query("SELECT count(*)::int AS n FROM pages WHERE owner = $1", [OTHER_OWNER])).rows[0].n;

    const snapshot = async (response) => ({
      status: response.status,
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
      body: await response.text(),
    });
    for (const [label, call] of [
      ["GET share", (id) => fetch(`${base}/api/pages/${id}/share`)],
      ["PUT share", (id) => write("PUT", `/api/pages/${id}/share`)],
      ["POST share/rotate", (id) => write("POST", `/api/pages/${id}/share/rotate`)],
      ["DELETE share", (id) => write("DELETE", `/api/pages/${id}/share`)],
      ["POST duplicate", (id) => write("POST", `/api/pages/${id}/duplicate`)],
      ["GET export.md", (id) => fetch(`${base}/api/pages/${id}/export.md`)],
    ]) {
      const results = [];
      for (const id of [otherId, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await call(id)));
      assert.equal(results[0].status, 404, label);
      assert.equal(results[0].body, '{"error":"not_found"}', label);
      for (const result of results.slice(1)) assert.deepEqual(result, results[0], `${label} responses must be identical`);
    }
    const shares = await pool.query("SELECT token FROM page_shares WHERE page_id = $1", [otherId]);
    assert.deepEqual(shares.rows, [{ token: otherToken }], "another owner's share is neither rotated nor stopped");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pages WHERE owner = $1", [OTHER_OWNER])).rows[0].n, before, "nothing was duplicated");
    // 他人の共有リンクは、ログインしていない人には読める（共有の目的どおり）
    assert.equal((await anonymous(`/s/${otherToken}`)).status, 200);
  });

  it("duplicates a page and exports its saved body as Markdown (#34)", async () => {
    const page = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(page.id);
    const blocks = [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
      { type: "paragraph", content: [{ type: "text", text: "太字", marks: [{ type: "bold" }] }, { type: "text", text: "と <script> と # 記号" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] }] },
    ];
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "合成の書き出し e2e", blocks, baseRevision: page.revision })).status, 200);
    assert.equal((await write("PUT", `/api/pages/${page.id}/share`)).status, 200);

    assert.equal((await write("POST", `/api/pages/${page.id}/duplicate`, undefined, { origin: "https://evil.example" })).status, 403);
    const duplicated = await write("POST", `/api/pages/${page.id}/duplicate`);
    assert.equal(duplicated.status, 201);
    const copy = (await duplicated.json()).page;
    createdIds.push(copy.id);
    assert.notEqual(copy.id, page.id);
    assert.equal(copy.title, "合成の書き出し e2eのコピー");
    assert.deepEqual(copy.blocks, blocks);
    assert.deepEqual((await (await fetch(`${base}/api/pages/${copy.id}/share`)).json()).share, PRIVATE_SHARE, "the share is not copied");
    assert.equal((await (await fetch(`${base}/api/pages/${page.id}`)).json()).page.title, "合成の書き出し e2e", "the original is unchanged");

    const exported = await fetch(`${base}/api/pages/${page.id}/export.md`);
    assert.equal(exported.status, 200);
    assert.equal(await exported.text(), "## 合成の見出し\n\n**太字**と \\<script\\> と \\# 記号\n\n- 項目\n");
    assert.equal(exported.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(exported.headers.get("content-disposition"), `attachment; filename="page.md"; filename*=UTF-8''${encodeURIComponent("合成の書き出し e2e.md")}`);
    assert.equal(exported.headers.get("cache-control"), "private, no-store");
    assert.equal(exported.headers.get("x-content-type-options"), "nosniff");
    assert.equal(exported.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  // ---- 録音と文字起こし（#36 段 1） ----

  // 合成の VTT（実在の人の名前・会話ではない）
  const SYNTHETIC_VTT = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:02.500",
    "<v 司会役>合成の録音をはじめます",
    "",
    "00:00:02.500 --> 00:00:04.000",
    "<v 記録役>合成の記録です",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "<v 司会役>一つ目の議題です",
    "",
  ].join("\n");

  it("imports a VTT into a recording page, edits a paragraph, renames and merges speakers, and refuses a stale revision (#36)", async () => {
    const created = await write("POST", "/api/recordings/import-vtt", { name: "合成の録音 e2e.vtt", vtt: SYNTHETIC_VTT });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "private, no-store");
    assert.equal(created.headers.get("x-robots-tag"), "noindex, nofollow");
    const { page, recording } = await created.json();
    createdIds.push(page.id);
    assert.equal(page.kind, "rec");
    assert.equal(page.title, "合成の録音 e2e");
    assert.equal(recording.revision, 1);
    assert.equal(recording.engine, "vtt-import");
    assert.equal(recording.durationSec, 6);
    assert.match(recording.sourceSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(recording.speakerNames, { 1: "司会役", 2: "記録役" });

    const read = await fetch(`${base}/api/pages/${page.id}/recording`);
    assert.equal(read.status, 200);
    const first = await read.json();
    assert.deepEqual(first.recording, recording);
    assert.deepEqual(first.speakers, [
      { speaker: 1, name: "司会役", count: 2 },
      { speaker: 2, name: "記録役", count: 1 },
    ]);

    // 段落をその場で直す
    const edited = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 1, edits: [{ index: 1, text: "合成の記録です。\r\n直しました" }] });
    assert.equal(edited.status, 200);
    const afterEdit = (await edited.json()).recording;
    assert.equal(afterEdit.revision, 2);
    assert.deepEqual(afterEdit.segments[1], { start: 2.5, end: 4, text: "合成の記録です。\n直しました", speaker: 2 });

    // 話者の名前を変える: 名前の表が 1 つなので、話者 1 の全ての段落に反映される
    const renamed = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 2, renameSpeaker: { speaker: 1, name: "進行役" } });
    assert.equal(renamed.status, 200);
    const afterRename = await renamed.json();
    assert.equal(afterRename.recording.revision, 3);
    assert.deepEqual(afterRename.recording.speakerNames, { 1: "進行役", 2: "記録役" });
    assert.deepEqual(afterRename.recording.segments.map((segment) => afterRename.recording.speakerNames[segment.speaker]), ["進行役", "記録役", "進行役"]);
    assert.deepEqual(afterRename.speakers, [
      { speaker: 1, name: "進行役", count: 2 },
      { speaker: 2, name: "記録役", count: 1 },
    ]);
    const clash = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 3, renameSpeaker: { speaker: 1, name: "記録役" } });
    assert.equal(clash.status, 400);
    assert.deepEqual(await clash.json(), { error: "bad_request", reason: "name" });

    // 同じ話者をまとめる
    const merged = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 3, mergeSpeakers: { from: 2, into: 1 } });
    assert.equal(merged.status, 200);
    const afterMerge = await merged.json();
    assert.equal(afterMerge.recording.revision, 4);
    assert.deepEqual(afterMerge.recording.segments.map((segment) => segment.speaker), [1, 1, 1]);
    assert.deepEqual(afterMerge.recording.speakerNames, { 1: "進行役" });
    assert.deepEqual(afterMerge.speakers, [{ speaker: 1, name: "進行役", count: 3 }]);
    assert.equal(afterMerge.recording.segments[1].text, "合成の記録です。\n直しました", "the earlier edit is kept");

    // 古い revision の書き込みは上書きせず、409 で最新を返す
    const stale = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 2, edits: [{ index: 0, text: "古い画面の文" }] });
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error, "conflict");
    assert.deepEqual(conflict.recording, afterMerge.recording);
    assert.deepEqual(conflict.speakers, afterMerge.speakers);
    const stored = await pool.query("SELECT revision, segments->0->>'text' AS first FROM page_recordings WHERE page_id = $1", [page.id]);
    assert.deepEqual(stored.rows[0], { revision: 4, first: "合成の録音をはじめます" });

    // 録音ページは普通のページとしても読める（本文は空）
    const asPage = (await (await fetch(`${base}/api/pages/${page.id}`)).json()).page;
    assert.equal(asPage.kind, "rec");
    assert.equal(asPage.title, "合成の録音 e2e");
    assert.deepEqual(asPage.blocks, []);

    // 別の origin・壊れた VTT・形の違う要求は断る（何も作らない・書かない）
    const count = async () => (await pool.query("SELECT count(*)::int AS n FROM page_recordings")).rows[0].n;
    const before = await count();
    assert.equal((await write("POST", "/api/recordings/import-vtt", { name: "a.vtt", vtt: SYNTHETIC_VTT }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 4, edits: [{ index: 0, text: "x" }] }, { origin: "https://evil.example" })).status, 403);
    const invalid = await write("POST", "/api/recordings/import-vtt", { name: "a.vtt", vtt: "合成のただの文字" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "bad_request", reason: "vtt_invalid" });
    const twoOps = await write("PATCH", `/api/pages/${page.id}/recording`, { baseRevision: 4, edits: [{ index: 0, text: "x" }], mergeSpeakers: { from: 1, into: 1 } });
    assert.equal(twoOps.status, 400);
    assert.deepEqual(await twoOps.json(), { error: "bad_request", reason: "body" });
    assert.equal(await count(), before);
    assert.equal((await pool.query("SELECT revision FROM page_recordings WHERE page_id = $1", [page.id])).rows[0].revision, 4);
  });

  it("answers the same 404 for another owner's recording, an unknown id, a malformed id, and a page without a recording (#36)", async () => {
    const other = await pool.query("INSERT INTO pages (owner, kind, title) VALUES ($1, 'rec', 'synthetic other recording') RETURNING id", [OTHER_OWNER]);
    const otherId = other.rows[0].id;
    createdIds.push(otherId);
    await pool.query(
      `INSERT INTO page_recordings (page_id, owner, source, language, segments, speaker_names)
       VALUES ($1, $2, 'vtt', 'ja', $3::jsonb, $4::jsonb)`,
      [otherId, OTHER_OWNER, JSON.stringify([{ start: 0, end: 1, text: "他人の合成の段落", speaker: 1 }]), JSON.stringify({ 1: "他人の話し手" })],
    );
    const plain = (await (await write("POST", "/api/pages", {})).json()).page;
    createdIds.push(plain.id);

    const snapshot = async (response) => ({
      status: response.status,
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
      body: await response.text(),
    });
    for (const [label, call] of [
      ["GET recording", (id) => fetch(`${base}/api/pages/${id}/recording`)],
      ["PATCH recording", (id) => write("PATCH", `/api/pages/${id}/recording`, { baseRevision: 1, renameSpeaker: { speaker: 1, name: "書き換え" } })],
    ]) {
      const results = [];
      for (const id of [otherId, randomUUID(), "not-a-uuid", plain.id]) results.push(await snapshot(await call(id)));
      assert.equal(results[0].status, 404, label);
      assert.equal(results[0].body, '{"error":"not_found"}', label);
      for (const result of results.slice(1)) assert.deepEqual(result, results[0], `${label} responses must be identical`);
    }
    const untouched = await pool.query("SELECT revision, speaker_names FROM page_recordings WHERE page_id = $1", [otherId]);
    assert.deepEqual(untouched.rows[0], { revision: 1, speaker_names: { 1: "他人の話し手" } });
  });
});

describe("editor-web e2e (niho until #19459, next dev)", () => {
  let base;
  let dev;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const createdIds = [];

  before(async () => {
    dev = await startDev("niho", 401);
    base = dev.base;
  });

  after(async () => {
    if (createdIds.length > 0) await pool.query("DELETE FROM pages WHERE id = ANY($1::uuid[])", [createdIds]);
    await pool.end();
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

  it("opens a shared link without signing in and without the editor frame, while the editor screens still ask for login (#34)", async () => {
    const page = await pool.query(
      `INSERT INTO pages (owner, title, blocks) VALUES ($1, '合成の共有 niho', '[{"type":"paragraph","content":[{"type":"text","text":"合成の共有 niho の本文"}]}]'::jsonb) RETURNING id`,
      [OTHER_OWNER],
    );
    const pageId = page.rows[0].id;
    createdIds.push(pageId);
    const token = "N".repeat(43);
    await pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, $3)", [pageId, OTHER_OWNER, token]);

    const shared = await fetch(`${base}/s/${token}`, { redirect: "manual" });
    assert.equal(shared.status, 200, "a shared link never goes to /auth/login");
    assert.equal(shared.headers.get("referrer-policy"), "no-referrer");
    assert.match(shared.headers.get("content-security-policy") ?? "", /'nonce-[^']+'/);
    const html = await shared.text();
    assert.match(html, /<h1>合成の共有 niho<\/h1>/);
    assert.match(html, /合成の共有 niho の本文/);
    assert.doesNotMatch(html, /aria-label="ページの一覧"/);

    for (const candidate of ["not-a-token", "M".repeat(43)]) {
      const missing = await fetch(`${base}/s/${candidate}`, { redirect: "manual" });
      assert.equal(missing.status, 404, candidate);
      assert.match(await missing.text(), /ページが見つかりません/);
    }
    // 共有したページでも、editor の画面はログインへ
    const editor = await fetch(`${base}/p/${pageId}`, { redirect: "manual" });
    assert.equal(editor.status, 307);
    assert.equal(editor.headers.get("location"), `/auth/login?next=%2Fp%2F${pageId}`);
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

// 公開のシート（#39）: stub の役割（writer,kamakura）と同梱の dev 用の宣言で、実 DB の公開・更新・やめる・再公開を確かめる。
describe("editor-web e2e (stub, next dev): 公開のシート (#39)", () => {
  let base;
  let dev;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const createdIds = [];
  const suffix = randomUUID().slice(0, 8);
  const READY = [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Getting there" }] },
    { type: "paragraph", content: [{ type: "text", text: "Meet at the station at 7:00." }] },
  ];
  const NONE = { app: false, news: false, xp: false };

  const write = (method, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const sheetOf = async (id, query = "") => {
    const response = await fetch(`${base}/api/pages/${id}/publish${query}`);
    assert.equal(response.status, 200);
    return (await response.json()).sheet;
  };
  const listRow = async (id) => (await (await fetch(`${base}/api/pages`)).json()).pages.find((page) => page.id === id);

  /** ページを作って題名と本文を保存する。返すのは id と今の revision。 */
  async function createPage(title, blocks) {
    const created = await write("POST", "/api/pages", {});
    assert.equal(created.status, 201);
    const { page } = await created.json();
    createdIds.push(page.id);
    const saved = await write("PATCH", `/api/pages/${page.id}`, { title, blocks, baseRevision: page.revision });
    assert.equal(saved.status, 200);
    return { id: page.id, revision: (await saved.json()).page.revision };
  }

  before(async () => {
    dev = await startDev("stub", 200);
    base = dev.base;
  });

  after(async () => {
    if (createdIds.length > 0) {
      // 公開の行はページの削除を止める（ON DELETE RESTRICT）ので先に消す。公開版と転送はページと一緒に消える
      await pool.query("DELETE FROM publications WHERE page_id = ANY($1::uuid[])", [createdIds]);
      await pool.query("DELETE FROM pages WHERE id = ANY($1::uuid[])", [createdIds]);
    }
    await pool.end();
    await dev?.stop();
  });

  it("publishes, shows updated after an edit, publishes the update, stops, and publishes again at the same URL", async () => {
    const title = `Morning walk e2e ${suffix}`;
    const slug = `morning-walk-e2e-${suffix}`;
    const url = `https://niho.life/article/${slug}`;
    const page = await createPage(title, READY);

    const first = await sheetOf(page.id);
    assert.equal(first.status, "private");
    assert.deepEqual(first.destinations.map((entry) => [entry.handle, entry.available]), [["exp", true], ["niho", true]]);
    const plan = await sheetOf(page.id, "?handle=niho&range=live&extras=");
    assert.equal(plan.primary, "publish");
    assert.equal(plan.url, url);
    assert.deepEqual(plan.slug, { value: slug, editable: true, error: null });

    const published = await write("POST", `/api/pages/${page.id}/publish`, { handle: "niho", range: "live", extras: NONE });
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), { published: { status: "published", operation: "publish", url, version: 1, notices: [] } });
    assert.equal((await sheetOf(page.id)).status, "published");
    assert.deepEqual((await listRow(page.id)).publication, { dest: "niho", handle: "niho", range: "live", stopped: false });

    // 本文を直すと「更新あり」→ 更新を公開（同じ URL、版が進む）
    const edited = await write("PATCH", `/api/pages/${page.id}`, {
      blocks: [...READY, { type: "paragraph", content: [{ type: "text", text: "Added after publishing." }] }],
      baseRevision: page.revision,
    });
    assert.equal(edited.status, 200);
    const updated = await sheetOf(page.id);
    assert.equal(updated.status, "updated");
    assert.equal(updated.primary, "update");
    const update = await write("POST", `/api/pages/${page.id}/publish`, { handle: "niho", range: "live", extras: NONE });
    assert.equal(update.status, 200);
    assert.deepEqual((await update.json()).published, { status: "published", operation: "update", url, version: 2, notices: [] });
    assert.equal((await sheetOf(page.id)).status, "published");

    // 公開をやめる（NIHO の面は URL を一覧へ転送）。もう一度呼んでも同じ
    for (let round = 0; round < 2; round += 1) {
      const stopped = await write("POST", `/api/pages/${page.id}/publish/stop`);
      assert.equal(stopped.status, 200);
      assert.deepEqual(await stopped.json(), { stopped: { status: "stopped" } });
    }
    const afterStop = await sheetOf(page.id);
    assert.equal(afterStop.status, "stopped");
    assert.equal(afterStop.canStop, false);
    assert.equal(afterStop.primary, "publish");
    assert.deepEqual((await listRow(page.id)).publication, { dest: "niho", handle: "niho", range: "live", stopped: true });
    const redirects = () => pool.query("SELECT from_handle, from_slug, to_handle, to_slug FROM publication_redirects WHERE page_id = $1", [page.id]);
    assert.deepEqual((await redirects()).rows, [{ from_handle: "niho", from_slug: slug, to_handle: null, to_slug: null }], "the old URL goes to the list");

    // 再公開は同じ URL
    const again = await write("POST", `/api/pages/${page.id}/publish`, { handle: "niho", range: "live", extras: NONE });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).published, { status: "published", operation: "publish", url, version: 3, notices: [] });
    assert.deepEqual((await listRow(page.id)).publication, { dest: "niho", handle: "niho", range: "live", stopped: false });
    assert.deepEqual((await redirects()).rows, [], "the URL is live again");
  });

  it("refuses a body that misses the destination's conditions with 409 not_ready, and writes nothing", async () => {
    const page = await createPage(`No headings e2e ${suffix}`, [{ type: "paragraph", content: [{ type: "text", text: "Only a paragraph." }] }]);
    const plan = await sheetOf(page.id, "?handle=exp&range=live&extras=");
    assert.deepEqual(plan.problems.map((problem) => problem.id), ["headings"]);
    assert.equal(plan.primary, null);
    const refused = await write("POST", `/api/pages/${page.id}/publish`, { handle: "exp", range: "live", extras: NONE });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.error, "not_ready");
    assert.deepEqual(body.problems.map((problem) => problem.id), ["headings"]);
    assert.equal(body.message, "公開の前に直すところがあります");
    assert.equal((await listRow(page.id)).publication, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM publication_versions WHERE page_id = $1", [page.id])).rows[0].n, 0);
  });

  it("answers the same 404 for another owner's page and an unknown id, and refuses cross-origin writes with 403", async () => {
    const other = await pool.query("INSERT INTO pages (owner, title, blocks) VALUES ($1, 'synthetic other publish', $2::jsonb) RETURNING id", [OTHER_OWNER, JSON.stringify(READY)]);
    const otherId = other.rows[0].id;
    createdIds.push(otherId);
    const unknown = randomUUID();
    const snapshot = async (response) => ({ status: response.status, body: await response.text() });
    for (const [label, call] of [
      ["GET", (id) => fetch(`${base}/api/pages/${id}/publish`)],
      ["POST publish", (id) => write("POST", `/api/pages/${id}/publish`, { handle: "niho", range: "live", extras: NONE })],
      ["POST stop", (id) => write("POST", `/api/pages/${id}/publish/stop`)],
    ]) {
      const theirs = await snapshot(await call(otherId));
      assert.equal(theirs.status, 404, label);
      assert.deepEqual(await snapshot(await call(unknown)), theirs, label);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM publications WHERE page_id = $1", [otherId])).rows[0].n, 0);

    const mine = await createPage(`Cross origin e2e ${suffix}`, READY);
    for (const [path, body] of [
      [`/api/pages/${mine.id}/publish`, { handle: "niho", range: "live", extras: NONE }],
      [`/api/pages/${mine.id}/publish/stop`, undefined],
    ]) {
      const response = await write("POST", path, body, { origin: "https://evil.example" });
      assert.equal(response.status, 403, path);
      assert.equal(await response.text(), '{"error":"forbidden"}');
    }
    assert.equal((await listRow(mine.id)).publication, null);
  });
});
