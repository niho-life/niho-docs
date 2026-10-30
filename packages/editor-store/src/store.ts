import type {
  Block,
  CreatePageInput,
  OwnerId,
  Page,
  PageKind,
  PageLang,
  PagePatch,
  PageSummary,
  Queryable,
  StepStatus,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一覧で返す上限（段階読み込み・仮想化は #32）。 */
export const PAGE_LIST_LIMIT = 500;

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

type SummaryRow = Pick<PageRow, "id" | "kind" | "title" | "lang" | "created_at" | "updated_at">;

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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
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
      `SELECT id, kind, title, lang, created_at, updated_at
         FROM pages
        WHERE owner = $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC, id
        LIMIT $2`,
      [owner, limit],
    );
    return result.rows.map(toSummary);
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
