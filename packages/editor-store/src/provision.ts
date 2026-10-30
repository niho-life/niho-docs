import type { ClientBase } from "pg";
import { MIGRATIONS_TABLE } from "./migrate.ts";

/**
 * 本番の DB の 2 つのロール。migration を流すロール（表の所有者）と、アプリが使うロール。
 * アプリのロールは DML だけを持ち、DDL・migration の記録の書き換えはできない（第二の防御線）。
 * 識別子とパスワードは SQL に埋め込むため、下の規則に合うものだけを受け付ける。
 */
const ROLE_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
// 配備の bootstrap が生成する 16 進の文字列（openssl rand -hex）。英数字だけなので引用符の外れが起きない。
const PASSWORD_PATTERN = /^[A-Za-z0-9]{20,128}$/;

export type AppRole = { role: string; password: string };

/** `postgresql://<role>:<password>@…` からアプリのロール名とパスワードを取り出す。値は例外の文に含めない。 */
export function parseAppRoleUrl(value: string): AppRole {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the app database URL is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("the app database URL must use postgresql://");
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!ROLE_PATTERN.test(role)) throw new Error("the app role name must be lowercase letters, digits and underscores");
  if (!PASSWORD_PATTERN.test(password)) throw new Error("the app role password must be 20 to 128 alphanumeric characters");
  return { role, password };
}

function checkedRole(role: string): string {
  if (!ROLE_PATTERN.test(role)) throw new Error("invalid role name");
  return role;
}

function checkedSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error("invalid schema name");
  return schema;
}

/** アプリのロールを作る（あればパスワードを更新する）。ログイン可・DB と ROLE の作成は不可。 */
export async function ensureAppRole(client: Pick<ClientBase, "query">, { role, password }: AppRole): Promise<void> {
  const name = checkedRole(role);
  if (!PASSWORD_PATTERN.test(password)) throw new Error("invalid role password");
  // Cloud SQL では SUPERUSER を書くことすら許されない。既定が NOSUPERUSER なので書かない。
  await client.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
         CREATE ROLE ${name} LOGIN NOCREATEDB NOCREATEROLE;
       END IF;
     END $$`,
  );
  await client.query(`ALTER ROLE ${name} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
}

/**
 * アプリのロールの権限。既存の表への付与と、あとの migration が作る表への既定の権限（この接続のロールが作る分）。
 * migration の記録の表は読むだけ。何度流しても同じ結果になる。
 */
export async function applyAppGrants(client: Pick<ClientBase, "query">, role: string, schema = "public"): Promise<void> {
  const name = checkedRole(role);
  const target = checkedSchema(schema);
  const statements = [
    `GRANT USAGE ON SCHEMA ${target} TO ${name}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${target} TO ${name}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${target} TO ${name}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${target} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${target} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${name}`,
    `REVOKE ALL ON ${target}.${MIGRATIONS_TABLE} FROM ${name}`,
    `GRANT SELECT ON ${target}.${MIGRATIONS_TABLE} TO ${name}`,
  ];
  for (const statement of statements) await client.query(statement);
}
