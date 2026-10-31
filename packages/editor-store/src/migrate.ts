import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { ClientBase } from "pg";

/**
 * migration のファイル名の規則（数字 4 桁で始まる .sql。**辞書順に適用する**）。
 *
 * 2 つの形が混在する。どちらもこのパターンに合い、辞書順では "0" < "2" なので連番 → 日時の順に並ぶ。
 * - `0001_…`〜（連番）: 履歴。**名前を変えない**（適用済みの名前が editor_store_migrations の主キー）。
 * - `YYYYMMDDHHMMSS_…`（日時。これから作るもの）: `npm -C packages/editor-store run new-migration -- <名前>`
 *   が付ける。人が番号を選ぶと並行作業で取り合いになるため（実際に #90/#93 が 0008、#100/#93 が 0009 で
 *   衝突した）。同じ秒に 2 つできても名前が違うので両方入り、順序も決まる。
 */
export const MIGRATION_FILE_PATTERN = /^\d{4}.*\.sql$/;

/** 適用済みの migration を記録する表（search_path の先頭の schema に作る）。 */
export const MIGRATIONS_TABLE = "editor_store_migrations";

/** 別々の migrate が同時に走ったときに 1 つずつにするための advisory lock の鍵（固定の任意値）。 */
const MIGRATION_LOCK_KEY = 4_660_046_047;

const TRANSACTION_WRAPPER = /^\s*BEGIN;\s*\n([\s\S]*?)\n\s*COMMIT;\s*$/;

export const defaultMigrationsDir = new URL("../migrations/", import.meta.url);

export type MigrationFile = { name: string; sql: string; checksum: string };

export async function readMigrations(dir: URL = defaultMigrationsDir): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(new URL(name, dir), "utf8");
    files.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return files;
}

/**
 * 各ファイルは BEGIN; … COMMIT; で包まれている（そのまま psql でも流せる）。ここでは包みを外し、
 * 本文と「適用済み」の記録を同じ transaction に入れる（途中で落ちても半分だけ適用済みにならない）。
 */
export function migrationBody(file: Pick<MigrationFile, "name" | "sql">): string {
  const match = TRANSACTION_WRAPPER.exec(file.sql);
  if (!match?.[1]) throw new Error(`migration ${file.name} must be wrapped in BEGIN; ... COMMIT;`);
  return match[1];
}

export type MigrationResult = { applied: string[]; skipped: string[] };

/**
 * 未適用の migration だけを辞書順に適用する。適用済みのファイルが書き換えられていたら止める。
 * lock と transaction は接続ごとなので、Pool ではなく 1 本の接続（Client / PoolClient）を渡す。
 */
export async function applyMigrations(client: Pick<ClientBase, "query">, dir: URL = defaultMigrationsDir): Promise<MigrationResult> {
  const files = await readMigrations(dir);
  const applied: string[] = [];
  const skipped: string[] = [];
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name text PRIMARY KEY,
         checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${MIGRATIONS_TABLE}`)).rows.map(
        (row) => [row.name, row.checksum] as const,
      ),
    );
    for (const file of files) {
      const recorded = done.get(file.name);
      if (recorded !== undefined) {
        if (recorded !== file.checksum) throw new Error(`migration ${file.name} was changed after it was applied`);
        skipped.push(file.name);
        continue;
      }
      const body = migrationBody(file);
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [file.name, file.checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
  return { applied, skipped };
}
