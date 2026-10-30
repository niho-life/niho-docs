// 起動した editor-web（`next dev`・EDITOR_AUTH_MODE=stub）に対して、ページを作る → 書く → 読み直すと残る、を確かめる。
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
      ["PATCH /api/pages/{id}", (id) => write("PATCH", `/api/pages/${id}`, { title: "overwrite" })],
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
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "合成の共有 e2e", blocks: first })).status, 200);
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
    assert.doesNotMatch(html.match(/<head>[\s\S]*?<\/head>/)?.[0].replace(/<script[\s\S]*?<\/script>/g, "") ?? "", new RegExp(token), "the token is not in the title or metadata");

    // 共有中に本文を保存し直すと、次に開いたときは新しい保存版
    const second = [{ type: "paragraph", content: [{ type: "text", text: "合成の共有 直した本文" }] }];
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { blocks: second })).status, 200);
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
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").map(([name, value]) => [name, value.replace(/\?v=\d+/g, "?v=")]).sort(),
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
    assert.equal((await write("PATCH", `/api/pages/${page.id}`, { title: "合成の書き出し e2e", blocks })).status, 200);
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
