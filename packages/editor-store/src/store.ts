import type {
  Block,
  CreatePageInput,
  OwnerId,
  Page,
  PageKind,
  PageChunk,
  PageChunkOptions,
  PageLang,
  PagePatch,
  PageSummary,
  Queryable,
  StepStatus,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一覧で一度に返す上限。 */
export const PAGE_LIST_LIMIT = 500;

/** listPageChunk の limit の既定。 */
const PAGE_CHUNK_DEFAULT = 100;

/**
 * 一覧の続きの位置（`<updated_at>_<id>`）。updated_at は PostgreSQL が出した UTC の文字列のまま持つ
 * （JavaScript の Date はマイクロ秒を落とすので、同じ時刻の行の境目がずれる）。
 */
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** cursor として読めない値（API は 400 にする）。 */
export class InvalidPageCursorError extends Error {
  override readonly name = "InvalidPageCursorError";
  constructor() {
    super("editor-store: invalid page list cursor");
  }
}

/** UUID の文字列として正しいか（正しくない id は DB に渡さず「無い」と同じに扱う）。 */
export function isPageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

type PageRow = {
  id: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  blocks: Block[];
  cover: string | null;
  lead: string | null;
  parent: string | null;
  recipe: string | null;
  step_status: StepStatus | null;
  created_at: Date;
  updated_at: Date;
};

type SummaryRow = Pick<PageRow, "id" | "kind" | "title" | "lang" | "parent" | "step_status" | "created_at" | "updated_at">;

const SUMMARY_COLUMNS = "id, kind, title, lang, parent, step_status, created_at, updated_at";

/** 一覧の区切りの行。cursor_time は updated_at の UTC の文字列（マイクロ秒まで）。 */
type ChunkRow = SummaryRow & { cursor_time: string };

const PAGE_COLUMNS = "id, kind, title, lang, blocks, cover, lead, parent, recipe, step_status, created_at, updated_at";

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    blocks: row.blocks,
    cover: row.cover,
    lead: row.lead,
    parent: row.parent,
    recipe: row.recipe,
    stepStatus: row.step_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSummary(row: SummaryRow): PageSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    parent: row.parent,
    stepStatus: row.step_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseCursor(cursor: string): { time: string; id: string } {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new InvalidPageCursorError();
  return { time: match[1]!, id: match[2]! };
}

function isInvalidDatetime(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "22007" || code === "22008";
}

function assertOwner(owner: OwnerId): void {
  // 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしないための守り
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function isInvalidTextRepresentation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "22P02";
}

/**
 * ページの読み書き。全てのクエリを `owner = $n AND deleted_at IS NULL` で絞る。
 * 該当が無いとき（別の人のページ・削除済み・存在しない・UUID として不正な id）はどれも null を返す。
 * 呼び出し側はそれを同じ 404 にする（列挙を防ぐ）。
 */
export class EditorStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async createPage(owner: OwnerId, input: CreatePageInput = {}): Promise<Page> {
    assertOwner(owner);
    const result = await this.#db.query<PageRow>(
      `INSERT INTO pages (owner, kind, title, lang, blocks)
       VALUES ($1, COALESCE($2, 'note'), COALESCE($3, ''), COALESCE($4, 'ja'), COALESCE($5::jsonb, '[]'::jsonb))
       RETURNING ${PAGE_COLUMNS}`,
      [owner, input.kind ?? null, input.title ?? null, input.lang ?? null, input.blocks === undefined ? null : JSON.stringify(input.blocks)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("editor-store: insert returned no row");
    return toPage(row);
  }

  async listPages(owner: OwnerId, options: { limit?: number } = {}): Promise<PageSummary[]> {
    assertOwner(owner);
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM pages
        WHERE owner = $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC, id
        LIMIT $2`,
      [owner, limit],
    );
    return result.rows.map(toSummary);
  }

  /**
   * 一覧を limit 件ずつ（更新順。同じ時刻は id の降順）。cursor は前の区切りの next。
   * 読めない cursor は InvalidPageCursorError。
   */
  async listPageChunk(owner: OwnerId, options: PageChunkOptions = {}): Promise<PageChunk> {
    assertOwner(owner);
    const requested = options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : PAGE_CHUNK_DEFAULT;
    const limit = Math.max(1, Math.min(requested, PAGE_LIST_LIMIT));
    const after = options.cursor === undefined || options.cursor === null ? null : parseCursor(options.cursor);
    // 1 件多く読んで、続きがあるかを知る
    const params: unknown[] = [owner, limit + 1];
    if (after) params.push(after.time, after.id);
    let rows: ChunkRow[];
    try {
      const result = await this.#db.query<ChunkRow>(
        `SELECT ${SUMMARY_COLUMNS},
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
           FROM pages
          WHERE owner = $1 AND deleted_at IS NULL${after ? " AND (updated_at, id) < ($3::timestamptz, $4::uuid)" : ""}
          ORDER BY updated_at DESC, id DESC
          LIMIT $2`,
        params,
      );
      rows = result.rows;
    } catch (error) {
      // 形は合っていても日付として無い値（2 月 30 日など）
      if (after && isInvalidDatetime(error)) throw new InvalidPageCursorError();
      throw error;
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      pages: page.map(toSummary),
      next: rows.length > limit && last ? `${last.cursor_time}_${last.id}` : null,
    };
  }

  async getPage(owner: OwnerId, id: string): Promise<Page | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    try {
      const result = await this.#db.query<PageRow>(
        `SELECT ${PAGE_COLUMNS}
           FROM pages
          WHERE owner = $1 AND deleted_at IS NULL AND id = $2`,
        [owner, id],
      );
      const row = result.rows[0];
      return row ? toPage(row) : null;
    } catch (error) {
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  }

  /** 指定したものだけを変え、updated_at を進める。 */
  async savePage(owner: OwnerId, id: string, patch: PagePatch): Promise<Page | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    try {
      const result = await this.#db.query<PageRow>(
        `UPDATE pages
            SET kind = COALESCE($3, kind),
                title = COALESCE($4, title),
                lang = COALESCE($5, lang),
                blocks = COALESCE($6::jsonb, blocks),
                updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE owner = $1 AND deleted_at IS NULL AND id = $2
          RETURNING ${PAGE_COLUMNS}`,
        [
          owner,
          id,
          patch.kind ?? null,
          patch.title ?? null,
          patch.lang ?? null,
          patch.blocks === undefined ? null : JSON.stringify(patch.blocks),
        ],
      );
      const row = result.rows[0];
      return row ? toPage(row) : null;
    } catch (error) {
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  }
}
