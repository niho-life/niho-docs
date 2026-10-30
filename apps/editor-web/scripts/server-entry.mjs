// 本番の server の入口（Dockerfile・scripts/start-standalone.sh）。
// standalone の server.js は NODE_ENV を production に固定するので、port を開く前に本番の条件で認証の方式を検査し、
// EDITOR_AUTH_MODE=niho でなければ（未設定を含む）stub へ落とさずに非 0 で終わる（#47）。
// 検査の規則は src/auth/config.ts の 1 か所だけにある（Node が型を消してそのまま読む）。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAuthMode } from "../src/auth/config.ts";

const serverPath = process.argv[2];
if (!serverPath) {
  process.stderr.write("editor-web: usage: node scripts/server-entry.mjs <path to standalone server.js>\n");
  process.exit(2);
}

try {
  resolveAuthMode({ ...process.env, NODE_ENV: "production" });
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid auth configuration";
  process.stderr.write(`editor-web: refusing to start: ${message}\n`);
  process.exit(1);
}

await import(pathToFileURL(path.resolve(serverPath)).href);
