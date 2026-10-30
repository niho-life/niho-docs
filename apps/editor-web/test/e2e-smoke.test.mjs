// 起動した editor-web（`next dev`・EDITOR_AUTH_MODE=stub）に対して、ページを作る → 書く → 読み直すと残る、を確かめる。
// あわせて、古い revision の保存が 409 になること・版から戻せること・ゴミ箱へ入れて戻せることを確かめる。
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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("editor-web e2e (stub, next dev)", () => {
  let port;
  let base;
  let server;
  let serverLog = "";
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const createdIds = [];

  const write = (method, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  before(async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, EDITOR_AUTH_MODE: "stub", NEXT_TELEMETRY_DISABLED: "1" };
    delete env.NODE_ENV;
    server = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    server.stdout.on("data", (chunk) => (serverLog += chunk));
    server.stderr.on("data", (chunk) => (serverLog += chunk));
    const deadline = Date.now() + 240_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/pages`);
        if (response.status === 200) break;
      } catch {
        // まだ起動中
      }
      if (Date.now() > deadline) throw new Error(`next dev did not become ready:\n${serverLog.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  after(async () => {
    if (createdIds.length > 0) await pool.query("DELETE FROM pages WHERE id = ANY($1::uuid[])", [createdIds]);
    await pool.end();
    if (server?.pid) {
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
    }
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
    assert.match(home, new RegExp(`/p/${page.id}`));
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
    // （`next dev` は CSS の Link header に読み込みごとの `?v=時刻` を付けるので、その値だけは外して比べる）
    const devStable = (headers) => headers.map(([name, value]) => [name, value.replace(/\?v=\d+/g, "?v=")]);
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
    const listIds = async () => (await (await fetch(`${base}/api/pages`)).json()).pages.map((item) => item.id);
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

    // 公開中のページは削除しない
    await pool.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, '[]', 'publish')", [page.id]);
    await pool.query("INSERT INTO publications (page_id, dest, slug, range, published_version) VALUES ($1, 'synthetic', $2, 'live', 1)", [page.id, `e2e-${page.id}`]);
    try {
      const refused = await fetch(`${base}/api/pages/${page.id}`, { method: "DELETE", headers: { origin: base } });
      assert.equal(refused.status, 409);
      assert.equal(await refused.text(), '{"error":"published"}');
      assert.ok((await listIds()).includes(page.id));
    } finally {
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
});
