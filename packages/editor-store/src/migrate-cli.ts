// npm run migrate — DATABASE_URL の DB に未適用の migration を適用する。接続先の値は表示しない。
import pg from "pg";
import { applyMigrations } from "./migrate.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write("migrate: DATABASE_URL is not set\n");
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  const { applied, skipped } = await applyMigrations(client);
  for (const name of applied) process.stdout.write(`migrate: applied ${name}\n`);
  process.stdout.write(`migrate: ${applied.length} applied, ${skipped.length} already applied\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`migrate: failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
