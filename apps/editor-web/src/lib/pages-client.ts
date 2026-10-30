/** ブラウザから `/api/pages` を呼ぶ（同じ origin。cookie・token は扱わない）。 */

export type PageBody = {
  title?: string;
  blocks?: unknown[];
};

export type SaveRequestOptions = {
  /** 画面が持っているページの revision（楽観ロック）。 */
  baseRevision: number;
  /** 「この内容で上書き」（競合の応答の revision を取り直して送る）。 */
  overwrite?: boolean;
};

/** 競合の応答が持つ、今のページ（別の画面・端末が保存したもの）。 */
export type ConflictPage = {
  title: string;
  blocks: unknown[];
  revision: number;
  updatedAt: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PageRequestError extends Error {
  override readonly name: string = "PageRequestError";
  constructor(readonly status: number) {
    super(`page request failed with ${status}`);
  }
}

/** 別の画面・端末が先に保存していた（409）。何も保存されていない。`page` は今のページ。 */
export class PageConflictError extends PageRequestError {
  override readonly name: string = "PageConflictError";
  constructor(readonly page: ConflictPage) {
    super(409);
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function conflictPageOf(data: unknown): ConflictPage | null {
  const page = (data as { page?: Record<string, unknown> } | null)?.page;
  if (typeof page !== "object" || page === null) return null;
  const { title, blocks, revision, updatedAt } = page;
  if (typeof title !== "string" || !Array.isArray(blocks) || !isRevision(revision) || typeof updatedAt !== "string") return null;
  return { title, blocks, revision, updatedAt };
}

async function send(path: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 409) {
    const page = conflictPageOf(await response.json().catch(() => null));
    // 競合の形でない 409 はただの失敗として扱う
    throw page ? new PageConflictError(page) : new PageRequestError(409);
  }
  if (!response.ok) throw new PageRequestError(response.status);
  return response.json();
}

/** 新しい空のページを作り、その id を返す。 */
export async function createPageRequest(): Promise<string> {
  const data = (await send("/api/pages", "POST", {})) as { page?: { id?: unknown } };
  const id = data.page?.id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new PageRequestError(500);
  return id;
}

/**
 * ページの部分更新。`baseRevision` を付けて送り、保存後の revision を返す。
 * 別の画面・端末が先に保存していたら PageConflictError（何も保存されていない）。
 */
export async function savePageRequest(id: string, body: PageBody, options: SaveRequestOptions): Promise<number> {
  const payload = { ...body, baseRevision: options.baseRevision, ...(options.overwrite === true ? { overwrite: true } : {}) };
  const data = (await send(`/api/pages/${encodeURIComponent(id)}`, "PATCH", payload)) as { page?: { revision?: unknown } };
  const revision = data.page?.revision;
  if (!isRevision(revision)) throw new PageRequestError(500);
  return revision;
}
