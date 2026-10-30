import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { MIGRATIONS_TABLE, applyMigrations } from "../src/migrate.ts";
import { applyAppGrants, ensureAppRole, parseAppRoleUrl } from "../src/provision.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成の値だけを使う（実在のロール・パスワードではない）
const SYNTHETIC_PASSWORD = "0123456789abcdef0123456789abcdef01234567";

describe("parseAppRoleUrl", () => {
  it("takes the role and password from a Cloud SQL connector URL without echoing them", () => {
    const parsed = parseAppRoleUrl(`postgresql://niho_editor_app:${SYNTHETIC_PASSWORD}@localhost/niho_editor?host=/cloudsql/p:r:i`);
    assert.deepEqual(parsed, { role: "niho_editor_app", password: SYNTHETIC_PASSWORD });
  });

  it("rejects anything that could break out of the SQL it is interpolated into", () => {
    const bad = [
      `postgresql://Niho:${SYNTHETIC_PASSWORD}@localhost/db`,
      `postgresql://app;drop:${SYNTHETIC_PASSWORD}@localhost/db`,
      `postgresql://niho_editor_app:short@localhost/db`,
      `postgresql://niho_editor_app:${SYNTHETIC_PASSWORD}%27--@localhost/db`,
      `postgresql://niho_editor_app:${SYNTHETIC_PASSWORD.slice(0, 20)}%20x%27@localhost/db`,
      `postgresql://niho_editor_app@localhost/db`,
      `https://niho_editor_app:${SYNTHETIC_PASSWORD}@localhost/db`,
      "not a url",
    ];
    for (const value of bad) {
      assert.throws(() => parseAppRoleUrl(value), (error: unknown) => {
        assert.ok(error instanceof Error);
        // 例外の文に値（パスワード・ロール名の一部）を載せない
        assert.doesNotMatch(error.message, /0123456789abcdef|drop|Niho/);
        return true;
      });
    }
  });
});

describe("app role privileges on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_provision_test_${randomUUID().replaceAll("-", "")}`;
  const role = `editor_app_test_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(20).toString("hex");
  let admin: PgPool;
  let app: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    admin = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const client = await admin.connect();
    try {
      await applyMigrations(client);
      await ensureAppRole(client, { role, password });
      await applyAppGrants(client, role, schema);
    } finally {
      client.release();
    }
    const url = new URL(databaseUrl ?? "");
    url.username = role;
    url.password = password;
    app = new Pool({ connectionString: url.toString(), max: 2, options: `-c search_path=${schema}` });
  });

  after(async () => {
    await app?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("can log in and read, write and delete the application tables", async () => {
    const created = await app.query<{ id: string }>("INSERT INTO pages (owner, title) VALUES ('synthetic-owner-a', 't') RETURNING id");
    const id = created.rows[0]?.id;
    assert.ok(id);
    await app.query("UPDATE pages SET title = 'u' WHERE id = $1", [id]);
    assert.equal((await app.query("SELECT 1 FROM pages WHERE id = $1", [id])).rowCount, 1);
    await app.query("DELETE FROM pages WHERE id = $1", [id]);
    assert.equal((await app.query("SELECT 1 FROM pages WHERE id = $1", [id])).rowCount, 0);
  });

  it("cannot change the schema or rewrite the migration record", async () => {
    await assert.rejects(app.query("CREATE TABLE intruder (id int)"), /permission denied/);
    await assert.rejects(app.query("DROP TABLE pages"), /must be owner/);
    await assert.rejects(app.query(`DELETE FROM ${MIGRATIONS_TABLE}`), /permission denied/);
    await assert.rejects(app.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = checksum`), /permission denied/);
    assert.ok(((await app.query(`SELECT 1 FROM ${MIGRATIONS_TABLE}`)).rowCount ?? 0) > 0);
  });

  it("is not a superuser and cannot create roles or databases", async () => {
    const row = await app.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(row.rows[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false });
  });

  it("is idempotent, rotates the password, and covers tables a later migration creates", async () => {
    const rotated = randomBytes(20).toString("hex");
    const client = await admin.connect();
    try {
      await ensureAppRole(client, { role, password: rotated });
      await applyAppGrants(client, role, schema);
      await client.query("CREATE TABLE later_table (id int PRIMARY KEY)");
    } finally {
      client.release();
    }
    const { Pool } = await import("pg");
    const url = new URL(databaseUrl ?? "");
    url.username = role;
    url.password = rotated;
    const reconnected = new Pool({ connectionString: url.toString(), max: 1, options: `-c search_path=${schema}` });
    try {
      await reconnected.query("INSERT INTO later_table (id) VALUES (1)");
      assert.equal((await reconnected.query("SELECT id FROM later_table")).rowCount, 1);
    } finally {
      await reconnected.end();
    }
  });
});
