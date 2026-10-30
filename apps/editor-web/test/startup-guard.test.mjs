// 本番の起動の守り（#47）。`npm run build` の後に `npm run test:startup` で動かす。
// NODE_ENV=production で EDITOR_AUTH_MODE が niho でなければ（未設定を含む）、stub へ落とさずに起動が失敗し、port を開かないこと。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const standaloneServer = ".next/standalone/server.js";
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

if (!existsSync(new URL(`../${standaloneServer}`, import.meta.url))) {
  throw new Error("No production build found. Run `npm run build` before `npm run test:startup`.");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function childEnv(port, mode) {
  const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.EDITOR_AUTH_MODE;
  delete env.DATABASE_URL;
  if (mode !== undefined) env.EDITOR_AUTH_MODE = mode;
  return env;
}

/** 子プロセスを起動し、終わるまで（最大 timeoutMs）port に繋がるかを見張る。 */
async function runUntilExit(args, env, port, timeoutMs = 30_000) {
  const child = spawn(process.execPath, args, { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let opened = false;
  let done = false;
  const watch = (async () => {
    while (!done) {
      if (await canConnect(port)) opened = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const result = await exited;
  done = true;
  clearTimeout(timer);
  await watch;
  return { ...result, opened, output };
}

async function waitForHttp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/api/pages`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not answer in time");
}

describe("production start with the server entry (Dockerfile / npm start)", () => {
  for (const [label, mode] of [["EDITOR_AUTH_MODE=stub", "stub"], ["EDITOR_AUTH_MODE unset", undefined], ["EDITOR_AUTH_MODE empty", ""], ["EDITOR_AUTH_MODE=STUB", "STUB"]]) {
    it(`refuses to start and never opens the port with ${label}`, async () => {
      const port = await freePort();
      const result = await runUntilExit(["scripts/server-entry.mjs", standaloneServer], childEnv(port, mode), port);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(result.signal, null, "it must exit by itself, not by the test timeout");
      assert.equal(result.opened, false, "the port must stay closed");
      assert.match(result.output, /refusing to start/);
      assert.doesNotMatch(result.output, /Ready in/);
    });
  }

  it("starts with EDITOR_AUTH_MODE=niho and answers 401 while niho login is not implemented", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      const response = await waitForHttp(port);
      assert.equal(response.status, 401);
      assert.equal(await response.text(), '{"error":"unauthorized"}');
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(home.headers.get("x-robots-tag"), "noindex, nofollow");
      const html = await home.text();
      assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
      assert.doesNotMatch(html, /data-auth-mode="stub"/);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("sends a nonce-based CSP on pages, and every <script> carries that request's nonce (#44)", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      await waitForHttp(port);
      const fetchHome = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        return { csp: response.headers.get("content-security-policy") ?? "", hsts: response.headers.get("strict-transport-security"), html: await response.text() };
      };
      const first = await fetchHome();
      const second = await fetchHome();
      const nonceOf = (policy) => /'nonce-([^']+)'/.exec(policy)?.[1];
      const nonce = nonceOf(first.csp);
      assert.ok(nonce, "the policy must carry a nonce");
      assert.notEqual(nonce, nonceOf(second.csp), "the nonce must change on every request");
      const scriptSrc = first.csp.split("; ").find((part) => part.startsWith("script-src ")) ?? "";
      assert.match(scriptSrc, /'strict-dynamic'/);
      assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);
      assert.match(first.csp, /frame-ancestors 'none'/);
      assert.match(first.csp, /upgrade-insecure-requests/);
      const scripts = [...first.html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      assert.ok(scripts.length > 0, "the page must have scripts for this check to mean anything");
      for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `a <script> without this request's nonce: ${tag.slice(0, 80)}`);
      assert.equal(first.hsts, "max-age=31536000; includeSubDomains");
      // API は JSON だけ: 何も読み込まない固定の CSP
      const api = await fetch(`http://127.0.0.1:${port}/api/pages`);
      assert.equal(api.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("production start without the entry (defence in depth)", () => {
  it("standalone server.js exits non-zero with EDITOR_AUTH_MODE=stub", async () => {
    const port = await freePort();
    const result = await runUntilExit([standaloneServer], childEnv(port, "stub"), port);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /refusing to start/);
  });

  it("`next start` exits non-zero with EDITOR_AUTH_MODE unset", async () => {
    const port = await freePort();
    const result = await runUntilExit([nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], childEnv(port, undefined), port);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /refusing to start/);
  });
});
