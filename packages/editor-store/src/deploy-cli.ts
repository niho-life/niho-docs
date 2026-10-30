// Cloud Run ジョブ（配備のたびに 1 回）の入口。migration のロールの接続（DATABASE_URL）で
//   1. 未適用の migration を適用する
//   2. EDITOR_APP_DATABASE_URL があれば、アプリのロールを作り（あればパスワードを更新し）、権限を付ける
// 接続先・パスワードは表示しない（ロール名と migration 名だけ）。
import pg from "pg";
import { applyMigrations } from "./migrate.ts";
import { applyAppGrants, ensureAppRole, parseAppRoleUrl } from "./provision.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write("deploy-migrate: DATABASE_URL is not set\n");
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  const appUrl = process.env.EDITOR_APP_DATABASE_URL;
  const appRole = appUrl ? parseAppRoleUrl(appUrl) : undefined;
  await client.connect();
  const { applied, skipped } = await applyMigrations(client);
  for (const name of applied) process.stdout.write(`deploy-migrate: applied ${name}\n`);
  process.stdout.write(`deploy-migrate: ${applied.length} applied, ${skipped.length} already applied\n`);
  if (appRole) {
    await ensureAppRole(client, appRole);
    await applyAppGrants(client, appRole.role);
    process.stdout.write(`deploy-migrate: role ${appRole.role} ready\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`deploy-migrate: failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
