import { randomBytes } from "node:crypto";
import { isPageId } from "./store.ts";
import type { Block, OwnerId, PageLang, Queryable } from "./types.ts";

/**
 * リンクで共有（#34）。共有中のページに page_shares の 1 行（migrations/0004_page_shares.sql）。
 * 本人の操作（get・enable・rotate・stop）は全て `owner = $1 AND deleted_at IS NULL` のページだけに効き、
 * 別の人のページ・削除済み・存在しない・UUID として不正な id はどれも null を返す（呼び出し側は同じ 404 にする）。
 * token は応答の共有 URL のためだけに返す。ログ・エラーの文言に入れない。
 */

/** 共有の token の形（256 bit の乱数の base64url。0004 の CHECK と同じ）。 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 本人から見た共有の状態。共有していなければ `{ shared: false }`。 */
export type PageShareState =
  | { shared: false }
  | { shared: true; token: string; createdAt: string; rotatedAt: string | null };

/** 共有リンクで読めるもの（id・owner・token・kind は含めない）。本文は最新の保存版。 */
export type SharedPage = {
  title: string;
  lang: PageLang;
  blocks: Block[];
  updatedAt: string;
};

/** token の形として正しいか（正しくない token は DB に問い合わせない）。 */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

/** 新しい token（256 bit の乱数）。 */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

type ShareRow = { token: string; created_at: Date; rotated_at: Date | null };

function toState(row: ShareRow): PageShareState {
  return {
    shared: true,
    token: row.token,
    createdAt: row.created_at.toISOString(),
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
  };
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り: 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしない
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function isInvalidTextRepresentation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "22P02";
}

/** 本人の・ゴミ箱でないページ（共有の操作の対象）。$1 owner / $2 page id。 */
const OWN_PAGE = "SELECT id, owner FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL";

const GET_SQL = `
SELECT s.token, s.created_at, s.rotated_at
  FROM pages AS p
  LEFT JOIN page_shares AS s ON s.owner = p.owner AND s.page_id = p.id
 WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`;

// 既にあればそのまま（同じ token）。新しく入れた行か、前からある行のどちらか 1 行を返す。
// 同じ文の中の SELECT は INSERT の前の snapshot を見るので、2 つの枝は同時には行を返さない。
const ENABLE_SQL = `
WITH page AS (${OWN_PAGE}),
inserted AS (
  INSERT INTO page_shares (page_id, owner, token)
  SELECT id, owner, $3 FROM page
  ON CONFLICT (page_id) DO NOTHING
  RETURNING token, created_at, rotated_at
)
SELECT token, created_at, rotated_at FROM inserted
UNION ALL
SELECT s.token, s.created_at, s.rotated_at
  FROM page_shares AS s
  JOIN page AS p ON s.owner = p.owner AND s.page_id = p.id`;

// 共有中なら token を入れ替えて rotated_at を入れる。共有していなければ新しく始める（enable と同じ）。
const ROTATE_SQL = `
WITH page AS (${OWN_PAGE})
INSERT INTO page_shares (page_id, owner, token)
SELECT id, owner, $3 FROM page
ON CONFLICT (page_id) DO UPDATE
   SET token = EXCLUDED.token,
       rotated_at = greatest(clock_timestamp(), page_shares.created_at)
 WHERE page_shares.owner = EXCLUDED.owner
RETURNING token, created_at, rotated_at`;

// 行を消す（無くても成功）。ページが本人のものなら 1 行（id）を返す。
// WITH の中の DELETE は、主の SELECT が読まなくても必ず最後まで実行される（PostgreSQL の data-modifying CTE）。
const STOP_SQL = `
WITH page AS (${OWN_PAGE}),
removed AS (
  DELETE FROM page_shares AS s
   USING page AS p
   WHERE s.owner = p.owner AND s.page_id = p.id
  RETURNING s.page_id
)
SELECT p.id FROM page AS p`;

// 認証なしの読み取り。ページは毎回 join し、ゴミ箱のページは返さない。
const READ_SHARED_SQL = `
SELECT p.title, p.lang, p.blocks, p.updated_at
  FROM page_shares AS s
  JOIN pages AS p ON p.owner = s.owner AND p.id = s.page_id
 WHERE s.token = $1 AND p.deleted_at IS NULL`;

async function guardedQuery<T>(run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

/** 本人のページの共有の状態。ページが無ければ null。 */
export async function getShare(db: Queryable, owner: OwnerId, pageId: string): Promise<PageShareState | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  return guardedQuery(async () => {
    const result = await db.query<{ token: string | null; created_at: Date | null; rotated_at: Date | null }>(GET_SQL, [owner, pageId]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.token === null || row.created_at === null) return { shared: false };
    return toState({ token: row.token, created_at: row.created_at, rotated_at: row.rotated_at });
  });
}

/** 共有を始める（冪等: 既に共有中なら同じ token を返す）。ページが無ければ null。 */
export async function enableShare(db: Queryable, owner: OwnerId, pageId: string): Promise<PageShareState | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  return guardedQuery(async () => {
    // 同時に 2 つ始めたとき、後の文は先の行を待って何もせず、自分の snapshot では見えないので 0 行になる。そのときは読み直す。
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await db.query<ShareRow>(ENABLE_SQL, [owner, pageId, newShareToken()]);
      const row = result.rows[0];
      if (row) return toState(row);
      const current = await getShare(db, owner, pageId);
      if (current === null || current.shared) return current;
    }
    return getShare(db, owner, pageId);
  });
}

/** リンクを作り直す（新しい token。古い token では読めなくなる）。共有していなければ始める。ページが無ければ null。 */
export async function rotateShare(db: Queryable, owner: OwnerId, pageId: string): Promise<PageShareState | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  return guardedQuery(async () => {
    const result = await db.query<ShareRow>(ROTATE_SQL, [owner, pageId, newShareToken()]);
    const row = result.rows[0];
    return row ? toState(row) : null;
  });
}

/** 共有を止める（冪等: 行を消す。その時から token では読めない）。ページが無ければ null。 */
export async function stopShare(db: Queryable, owner: OwnerId, pageId: string): Promise<PageShareState | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  return guardedQuery(async () => {
    const result = await db.query<{ id: string }>(STOP_SQL, [owner, pageId]);
    return result.rows[0] ? { shared: false } : null;
  });
}

/**
 * 共有リンクで読む（認証なし）。token が形として正しくなければ DB に問い合わせずに null。
 * 共有していない・止めた・作り直した後の古い token・ゴミ箱のページはどれも null（呼び出し側は同じ 404 にする）。
 */
export async function readSharedPage(db: Queryable, token: string): Promise<SharedPage | null> {
  if (!isShareToken(token)) return null;
  const result = await db.query<{ title: string; lang: PageLang; blocks: Block[]; updated_at: Date }>(READ_SHARED_SQL, [token]);
  const row = result.rows[0];
  if (!row) return null;
  return { title: row.title, lang: row.lang, blocks: row.blocks, updatedAt: row.updated_at.toISOString() };
}
