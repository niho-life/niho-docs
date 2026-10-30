// `next build` の standalone 出力（.next/standalone）には public/ も .next/static も入らない。
// 動かすのに要るので、build のあとに置いて standalone を自己完結にする（Dockerfile・scripts/start-standalone.sh・test:startup が同じ形で動く）。
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(appDir, ".next/standalone");
if (!existsSync(path.join(standalone, "server.js"))) throw new Error("no standalone build: run `next build` first");

for (const [from, to] of [
  ["public", "public"],
  [".next/static", ".next/static"],
]) {
  const target = path.join(standalone, to);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(appDir, from), target, { recursive: true });
  process.stdout.write(`copied ${from} -> .next/standalone/${to}\n`);
}
