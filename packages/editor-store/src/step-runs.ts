import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { Block, OwnerId, Queryable, StepStatus } from "./types.ts";

/**
 * 手順（#37）の実行の層。docs/architecture/editor-steps-execution.md §5（方式 B）。
 *
 * 状態遷移はすべて「世代（generation）と状態を条件にした UPDATE」（CAS）で行い、読んだ値をもとに書かない。
 * 複数の行を書く遷移は 1 transaction で、最初に run の行を FOR UPDATE で取る（同じ run の遷移を直列にし、
 * 行の lock の順を run → attempt → ページ に固定してデッドロックを避ける）。サブページを書くのは、その親で
 * 進行中の唯一の run だけ（step_runs_active_idx）なので、別の run とサブページの lock を取り合わない。
 */

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ATTEMPT_STATES = ["pending", "queued", "running", "succeeded", "failed", "canceled", "reused"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** 1 つの段階を実行する回数の上限（自動の再試行は 2 回まで。設計 §7）。 */
export const MAX_TRIES = 3;

/** lease の既定の長さ（秒）。実行する側は 1/3 おきに生存確認で延ばす。 */
export const DEFAULT_LEASE_SECONDS = 120;

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** エラーの種類の code（短い英小文字・数字・_ だけ。本文や内部の情報は入れない）。 */
export function isStepErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}

/** `Idempotency-Key` の値（1〜128 の英数字と `-` `_`）。 */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * 手順の定義（editor-web が docs-core のテンプレートから作って渡すデータ。この package は docs-core に依存しない）。
 * editor-web の `RecipeDef` をそのまま渡せる形。
 */
export type StepRecipe = {
  readonly id: string;
  readonly steps: readonly { readonly id: string; readonly name: string; readonly instruction: string }[];
};

/** この層が使う pg の Pool の部分（transaction のために connect も使う）。 */
export type StepRunsDb = Pick<Pool, "query" | "connect">;

export type StepRunStepView = {
  index: number;
  stepId: string;
  state: AttemptState;
  pageId: string;
  /** サブページの段階の状態（サブページが削除されていれば null）。 */
  stepStatus: StepStatus | null;
  tries: number;
  errorCode: string | null;
};

export type StepRunView = {
  id: string;
  recipe: string;
  state: RunState;
  fromStep: number;
  steps: StepRunStepView[];
};

// ---------------------------------------------------------------------------
// 純粋な部分

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 段階の結果を書くサブページの id。親・recipe・段階から決定的に作る（作り直しても同じページになる）。
 * `sha256(parent + ':' + recipe + ':' + stepIndex)` の先頭 16 byte を UUID v5 の形（version 5・RFC 4122 の variant）に整える。
 */
export function stepPageId(parentId: string, recipeId: string, stepIndex: number): string {
  const digest = createHash("sha256").update(`${parentId.toLowerCase()}:${recipeId}:${stepIndex}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** キーを辞書順に並べた JSON（同じ内容なら key の順に関わらず同じ文字列）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** docs-core の hashText の写し（64 bit の非暗号のハッシュ。16 進 16 文字）。 */
function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * 指示文の前提。docs-core の `stepHash` と同じ値（前後の空白だけの違いは同じ）。
 * この package を docs-core に依存させないため写しを持ち、editor-web の test（src/steps/recipes.test.ts）が一致を確かめる。
 */
export function instructionHash(instruction: string): string {
  return hashText(instruction.trim());
}

/**
 * 段階の入力の基準（前提変更の判定に使う）。`sha256(正規化した前の段階の blocks の JSON + '\n' + stepHash(指示文))`。
 * 段階 0 の「前の段階」は録音ページの blocks。
 */
export function computeBasis(prevBlocks: readonly Block[], instruction: string): string {
  return createHash("sha256").update(`${canonicalJson(prevBlocks)}\n${instructionHash(instruction)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// DB の部分

function assertOwner(owner: OwnerId): void {
  // 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしないための守り（store.ts と同じ）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function assertRecipe(recipe: StepRecipe): void {
  if (typeof recipe.id !== "string" || recipe.id.length === 0 || recipe.id.length > 256 || recipe.steps.length === 0) {
    throw new TypeError("editor-store: recipe must have an id and at least one step");
  }
}

function assertLease(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new RangeError("editor-store: lease must be 0 < seconds <= 3600");
}

/** 書いたものを捨てて値を返す（transaction の中から使う）。 */
class Rollback<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

async function inTransaction<T>(db: StepRunsDb, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Rollback) return error.value as T;
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

type ViewRow = {
  id: string;
  recipe: string;
  state: RunState;
  from_step: number;
  step_index: number;
  step_id: string;
  step_state: AttemptState;
  page_id: string;
  tries: number;
  error_code: string | null;
  step_status: StepStatus | null;
};

async function loadRunView(db: Queryable, owner: OwnerId, runId: string): Promise<StepRunView | null> {
  const result = await db.query<ViewRow>(
    `SELECT r.id, r.recipe, r.state, r.from_step,
            a.step_index, a.step_id, a.state AS step_state, a.page_id, a.tries, a.error_code,
            p.step_status
       FROM step_runs r
       JOIN step_attempts a ON a.run_id = r.id
       LEFT JOIN pages p ON p.id = a.page_id AND p.owner = r.owner AND p.deleted_at IS NULL
      WHERE r.owner = $1 AND r.id = $2
      ORDER BY a.step_index`,
    [owner, runId],
  );
  const first = result.rows[0];
  if (!first) return null;
  return {
    id: first.id,
    recipe: first.recipe,
    state: first.state,
    fromStep: first.from_step,
    steps: result.rows.map((row) => ({
      index: row.step_index,
      stepId: row.step_id,
      state: row.step_state,
      pageId: row.page_id,
      stepStatus: row.step_status,
      tries: row.tries,
      errorCode: row.error_code,
    })),
  };
}

async function requireRunView(db: Queryable, owner: OwnerId, runId: string): Promise<StepRunView> {
  const view = await loadRunView(db, owner, runId);
  if (!view) throw new Error("editor-store: run disappeared");
  return view;
}

export type CreateRunInput = {
  recipe: StepRecipe;
  /** ここから作り直す（既定 0）。前の段階は完了済みのサブページを再利用する。 */
  fromStep?: number;
  idempotencyKey?: string | null;
};

export type CreateRunResult =
  | { status: "created"; run: StepRunView }
  /** 同じ `Idempotency-Key` の run が既にある（新しく作らない）。 */
  | { status: "existing"; run: StepRunView }
  /** 親が本人の録音ページでない（別の人・削除済み・存在しない・不正な id）。404 にする。 */
  | { status: "not_found" }
  /** 同じ録音ページで queued / running の run が既にある。409 にする。 */
  | { status: "run_in_progress" }
  /** `fromStep` より前に完了済みのサブページが無い段階がある。400 にする。 */
  | { status: "invalid_from_step" };

/**
 * run を作る。`fromStep` 以降のサブページを用意して `wait` に戻し（削除されていれば戻す）、`fromStep` の attempt を
 * `queued`・以降を `pending`・前を `reused` にする。親・冪等・進行中の検査と作成を同じ transaction で行う。
 */
export async function createRun(db: StepRunsDb, owner: OwnerId, parentId: string, input: CreateRunInput): Promise<CreateRunResult> {
  assertOwner(owner);
  assertRecipe(input.recipe);
  const { recipe } = input;
  const fromStep = input.fromStep ?? 0;
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep >= recipe.steps.length) {
    throw new RangeError("editor-store: fromStep is out of range");
  }
  const key = input.idempotencyKey ?? null;
  if (key !== null && !isIdempotencyKey(key)) throw new TypeError("editor-store: invalid idempotency key");
  if (!isPageId(parentId)) return { status: "not_found" };

  return inTransaction<CreateRunResult>(db, async (client) => {
    // 親が本人の生きている録音ページであること（作り終えるまで削除させない）
    const parent = await client.query<{ id: string; lang: string }>(
      `SELECT id, lang FROM pages
        WHERE owner = $1 AND id = $2 AND kind = 'rec' AND deleted_at IS NULL
        FOR SHARE`,
      [owner, parentId],
    );
    const parentRow = parent.rows[0];
    if (!parentRow) throw new Rollback<CreateRunResult>({ status: "not_found" });
    const parentKey = parentRow.id;

    const existingByKey = async (): Promise<string | null> => {
      if (key === null) return null;
      const found = await client.query<{ id: string }>("SELECT id FROM step_runs WHERE owner = $1 AND idempotency_key = $2", [owner, key]);
      return found.rows[0]?.id ?? null;
    };
    const replay = await existingByKey();
    if (replay) return { status: "existing", run: await requireRunView(client, owner, replay) } satisfies CreateRunResult;

    // 進行中の run・同じ key の run とぶつかったら作らない（一意の索引が判定する。読んでから作る race を作らない）
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO step_runs (owner, parent, recipe, from_step, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [owner, parentKey, recipe.id, fromStep, key],
    );
    const runId = inserted.rows[0]?.id;
    if (!runId) {
      const raced = await existingByKey();
      if (raced) return { status: "existing", run: await requireRunView(client, owner, raced) } satisfies CreateRunResult;
      throw new Rollback<CreateRunResult>({ status: "run_in_progress" });
    }

    const pageIds = recipe.steps.map((_, index) => stepPageId(parentKey, recipe.id, index));

    // fromStep より前は、完了済みのサブページを再利用する（作り終えるまで状態を変えさせない）
    if (fromStep > 0) {
      const reused = await client.query(
        `SELECT id FROM pages
          WHERE owner = $1 AND parent = $2 AND recipe = $3 AND kind = 'step' AND deleted_at IS NULL
            AND step_status = 'done' AND id = ANY($4::uuid[])
          FOR SHARE`,
        [owner, parentKey, recipe.id, pageIds.slice(0, fromStep)],
      );
      if (reused.rowCount !== fromStep) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });
    }

    // fromStep 以降のサブページ（無ければ作り、あれば wait に戻す。削除されていれば戻す）
    const upserted = await client.query(
      `INSERT INTO pages (id, owner, kind, title, lang, parent, recipe, step_status)
       SELECT v.id, $1::text, 'step', v.title, $3::text, $2::uuid, $4::text, 'wait'
         FROM unnest($5::uuid[], $6::text[]) AS v(id, title)
       ON CONFLICT (id) DO UPDATE
          SET step_status = 'wait', deleted_at = NULL
        WHERE pages.owner = EXCLUDED.owner AND pages.parent = EXCLUDED.parent
          AND pages.recipe = EXCLUDED.recipe AND pages.kind = 'step'
       RETURNING id`,
      [owner, parentKey, parentRow.lang, recipe.id, pageIds.slice(fromStep), recipe.steps.slice(fromStep).map((step) => step.name)],
    );
    if (upserted.rowCount !== recipe.steps.length - fromStep) throw new Error("editor-store: a step page id is taken by another page");

    await client.query(
      `INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state, finished_at)
       SELECT $1::uuid, v.step_index, v.step_id, v.page_id, v.state, CASE WHEN v.state = 'reused' THEN clock_timestamp() END
         FROM unnest($2::integer[], $3::text[], $4::uuid[], $5::text[]) AS v(step_index, step_id, page_id, state)`,
      [
        runId,
        recipe.steps.map((_, index) => index),
        recipe.steps.map((step) => step.id),
        pageIds,
        recipe.steps.map((_, index) => (index < fromStep ? "reused" : index === fromStep ? "queued" : "pending")),
      ],
    );
    return { status: "created", run: await requireRunView(client, owner, runId) } satisfies CreateRunResult;
  });
}

/** 親ページの最新の run（帯に出す）。親が本人のページでなければ null（404）。run が無ければ `{ run: null }`。 */
export async function listRun(db: Queryable, owner: OwnerId, parentId: string): Promise<{ run: StepRunView | null } | null> {
  assertOwner(owner);
  if (!isPageId(parentId)) return null;
  const found = await db.query<{ run_id: string | null }>(
    `SELECT r.id AS run_id
       FROM pages p
       LEFT JOIN LATERAL (
         SELECT id FROM step_runs
          WHERE owner = p.owner AND parent = p.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) r ON true
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [owner, parentId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { run: row.run_id ? await loadRunView(db, owner, row.run_id) : null };
}

export type StepClaim = {
  runId: string;
  stepIndex: number;
  /** この実行の世代。確定・失敗・生存確認に渡す。 */
  generation: number;
  tries: number;
  owner: OwnerId;
  parentId: string;
  recipe: string;
  stepId: string;
  pageId: string;
  /** 前の段階のサブページ（段階 0 は null）。 */
  previousPageId: string | null;
};

export type ClaimResult =
  | { ok: true; claim: StepClaim }
  /**
   * `run_inactive`: run が無い・終わっている（取消・失敗・成功）。
   * `not_queued`: attempt が queued でない（他が実行中・済み・まだ順番でない）。
   * `superseded`: 前の段階の結果が済み（succeeded / reused）でなくなっている（この段階を実行する前提が崩れた）。
   */
  | { ok: false; reason: "not_queued" | "run_inactive" | "superseded" };

/** queued の attempt を実行中にする（世代を 1 つ進め、lease を取る）。同時に何本来ても 1 本だけが通る。 */
export async function claimAttempt(
  db: StepRunsDb,
  runId: string,
  stepIndex: number,
  options: { leaseSeconds?: number } = {},
): Promise<ClaimResult> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (!isPageId(runId) || !Number.isInteger(stepIndex) || stepIndex < 0) return { ok: false, reason: "run_inactive" };
  return inTransaction<ClaimResult>(db, async (client) => {
    const run = await client.query<{ owner: string; parent: string; recipe: string; state: RunState }>(
      "SELECT owner, parent, recipe, state FROM step_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    const runRow = run.rows[0];
    if (!runRow || (runRow.state !== "queued" && runRow.state !== "running")) {
      return { ok: false, reason: "run_inactive" } satisfies ClaimResult;
    }
    const claimed = await client.query<{ generation: number; tries: number; step_id: string; page_id: string }>(
      `UPDATE step_attempts a
          SET state = 'running',
              generation = a.generation + 1,
              tries = a.tries + 1,
              lease_until = clock_timestamp() + make_interval(secs => $3::double precision),
              heartbeat_at = clock_timestamp(),
              started_at = clock_timestamp(),
              finished_at = NULL,
              error_code = NULL
        WHERE a.run_id = $1 AND a.step_index = $2 AND a.state = 'queued'
          AND (a.step_index = 0 OR EXISTS (
                SELECT 1 FROM step_attempts prev
                 WHERE prev.run_id = a.run_id AND prev.step_index = a.step_index - 1
                   AND prev.state IN ('succeeded', 'reused')))
        RETURNING a.generation, a.tries, a.step_id, a.page_id`,
      [runId, stepIndex, leaseSeconds],
    );
    const attempt = claimed.rows[0];
    if (!attempt) {
      // 通らなかった理由を返すためだけに読む（これをもとに書かない）
      const current = await client.query<{ state: AttemptState }>("SELECT state FROM step_attempts WHERE run_id = $1 AND step_index = $2", [runId, stepIndex]);
      return { ok: false, reason: current.rows[0]?.state === "queued" ? "superseded" : "not_queued" } satisfies ClaimResult;
    }
    await client.query(
      "UPDATE step_runs SET state = 'running', updated_at = GREATEST(clock_timestamp(), updated_at) WHERE id = $1 AND state IN ('queued', 'running')",
      [runId],
    );
    await client.query("UPDATE pages SET step_status = 'run' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [runRow.owner, attempt.page_id]);
    const previous = stepIndex === 0
      ? null
      : (await client.query<{ page_id: string }>("SELECT page_id FROM step_attempts WHERE run_id = $1 AND step_index = $2", [runId, stepIndex - 1])).rows[0]?.page_id ?? null;
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: runRow.owner,
        parentId: runRow.parent,
        recipe: runRow.recipe,
        stepId: attempt.step_id,
        pageId: attempt.page_id,
        previousPageId: previous,
      },
    } satisfies ClaimResult;
  });
}

export type AttemptRef = { runId: string; stepIndex: number; generation: number };

/** 生存確認。世代が一致して実行中のときだけ lease を延ばす。違えば false（取消・掃除のあと。実行をやめる）。 */
export async function heartbeatAttempt(db: Queryable, ref: AttemptRef, options: { leaseSeconds?: number } = {}): Promise<boolean> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (!isPageId(ref.runId)) return false;
  const result = await db.query(
    `UPDATE step_attempts
        SET lease_until = clock_timestamp() + make_interval(secs => $4::double precision),
            heartbeat_at = clock_timestamp()
      WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'`,
    [ref.runId, ref.stepIndex, ref.generation, leaseSeconds],
  );
  return result.rowCount === 1;
}

export type StepInput = { parentBlocks: Block[]; previousBlocks: Block[] | null };

/** 段階の入力（録音ページと前の段階のサブページの blocks）。owner で絞る。どちらかが読めなければ null。 */
export async function readStepInput(
  db: Queryable,
  claim: Pick<StepClaim, "owner" | "parentId" | "previousPageId">,
): Promise<StepInput | null> {
  assertOwner(claim.owner);
  const result = await db.query<{ parent_blocks: Block[] | null; previous_blocks: Block[] | null }>(
    `SELECT (SELECT blocks FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL) AS parent_blocks,
            (SELECT blocks FROM pages WHERE owner = $1 AND id = $3 AND deleted_at IS NULL) AS previous_blocks`,
    [claim.owner, claim.parentId, claim.previousPageId],
  );
  const row = result.rows[0];
  if (!row?.parent_blocks) return null;
  if (claim.previousPageId !== null && !row.previous_blocks) return null;
  return { parentBlocks: row.parent_blocks, previousBlocks: claim.previousPageId === null ? null : row.previous_blocks };
}

export type CommitInput = AttemptRef & { blocks: readonly Block[]; inputBasis: string };

export type CommitResult =
  /** `next`: 次に実行する段階（最後の段階なら null。run は succeeded）。 */
  | { ok: true; next: number | null }
  /** `stale_generation`: 世代が古い・実行中でない（取消・掃除・再取得のあと）。何も書いていない。 */
  | { ok: false; reason: "stale_generation" | "page_missing" };

/**
 * 段階の確定（1 transaction）。サブページの本文と状態・attempt・次の attempt（または run の成功）を同時に書く。
 * 世代が一致して実行中のときだけ通る。サブページが削除されていたら何も書かずに `page_missing`。
 */
export async function commitAttempt(db: StepRunsDb, input: CommitInput): Promise<CommitResult> {
  if (!/^[0-9a-f]{64}$/.test(input.inputBasis)) throw new TypeError("editor-store: inputBasis must be a sha256 hex digest");
  if (!isPageId(input.runId)) return { ok: false, reason: "stale_generation" };
  return inTransaction<CommitResult>(db, async (client) => {
    const run = await client.query<{ owner: string; state: RunState }>("SELECT owner, state FROM step_runs WHERE id = $1 FOR UPDATE", [input.runId]);
    const runRow = run.rows[0];
    if (!runRow || runRow.state !== "running") return { ok: false, reason: "stale_generation" } satisfies CommitResult;
    const done = await client.query<{ page_id: string }>(
      `UPDATE step_attempts
          SET state = 'succeeded', input_basis = $4, finished_at = clock_timestamp(), lease_until = NULL, error_code = NULL
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
        RETURNING page_id`,
      [input.runId, input.stepIndex, input.generation, input.inputBasis],
    );
    const pageId = done.rows[0]?.page_id;
    if (!pageId) return { ok: false, reason: "stale_generation" } satisfies CommitResult;
    const page = await client.query(
      `UPDATE pages
          SET blocks = $3::jsonb, step_status = 'done', updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE owner = $1 AND id = $2 AND deleted_at IS NULL`,
      [runRow.owner, pageId, JSON.stringify(input.blocks)],
    );
    if (page.rowCount !== 1) throw new Rollback<CommitResult>({ ok: false, reason: "page_missing" });
    const next = await client.query<{ step_index: number }>(
      "UPDATE step_attempts SET state = 'queued' WHERE run_id = $1 AND step_index = $2 AND state = 'pending' RETURNING step_index",
      [input.runId, input.stepIndex + 1],
    );
    const nextIndex = next.rows[0]?.step_index;
    if (nextIndex !== undefined) return { ok: true, next: nextIndex } satisfies CommitResult;
    const finished = await client.query(
      `UPDATE step_runs
          SET state = 'succeeded', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE id = $1 AND state = 'running'
          AND NOT EXISTS (SELECT 1 FROM step_attempts WHERE run_id = $1 AND step_index > $2)`,
      [input.runId, input.stepIndex],
    );
    if (finished.rowCount !== 1) throw new Error("editor-store: the next step of a run is not pending");
    return { ok: true, next: null } satisfies CommitResult;
  });
}

/** run を失敗で終える（attempt は失敗にした後）。後続は canceled、サブページは失敗の段階が failed・後続が wait。 */
async function failRunFrom(client: PoolClient, owner: OwnerId, runId: string, stepIndex: number, pageId: string): Promise<void> {
  const rest = await client.query<{ page_id: string }>(
    `UPDATE step_attempts SET state = 'canceled', finished_at = clock_timestamp()
      WHERE run_id = $1 AND step_index > $2 AND state IN ('pending', 'queued')
      RETURNING page_id`,
    [runId, stepIndex],
  );
  await client.query(
    `UPDATE step_runs SET state = 'failed', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE id = $1 AND state IN ('queued', 'running')`,
    [runId],
  );
  await client.query(
    `UPDATE pages SET step_status = CASE WHEN id = $2 THEN 'failed' ELSE 'wait' END
      WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [owner, pageId, [pageId, ...rest.rows.map((row) => row.page_id)]],
  );
}

export type FailInput = AttemptRef & { code: string; retryable: boolean };

export type FailResult =
  /** もう一度積む（`generation` はこの attempt の今の世代。task の名前に入れる）。 */
  | { ok: true; outcome: "retry"; generation: number; tries: number }
  | { ok: true; outcome: "failed" }
  | { ok: false; reason: "stale_generation" };

/**
 * 段階の失敗。世代が一致して実行中のときだけ通る。`retryable` で `tries < MAX_TRIES` なら queued に戻し（lease を外す。
 * サブページは wait）、そうでなければ attempt を failed・後続を canceled・run を failed にする。
 */
export async function failAttempt(db: StepRunsDb, input: FailInput): Promise<FailResult> {
  if (!isStepErrorCode(input.code)) throw new TypeError("editor-store: error code must match ^[a-z0-9_]{1,64}$");
  if (!isPageId(input.runId)) return { ok: false, reason: "stale_generation" };
  return inTransaction<FailResult>(db, async (client) => {
    const run = await client.query<{ owner: string; state: RunState }>("SELECT owner, state FROM step_runs WHERE id = $1 FOR UPDATE", [input.runId]);
    const runRow = run.rows[0];
    if (!runRow || runRow.state !== "running") return { ok: false, reason: "stale_generation" } satisfies FailResult;
    const retried = await client.query<{ generation: number; tries: number; page_id: string }>(
      `UPDATE step_attempts
          SET state = 'queued', lease_until = NULL, heartbeat_at = NULL, error_code = $4
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
          AND $5::boolean AND tries < $6
        RETURNING generation, tries, page_id`,
      [input.runId, input.stepIndex, input.generation, input.code, input.retryable, MAX_TRIES],
    );
    const retry = retried.rows[0];
    if (retry) {
      await client.query("UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [runRow.owner, retry.page_id]);
      return { ok: true, outcome: "retry", generation: retry.generation, tries: retry.tries } satisfies FailResult;
    }
    const failed = await client.query<{ page_id: string }>(
      `UPDATE step_attempts
          SET state = 'failed', lease_until = NULL, error_code = $4, finished_at = clock_timestamp()
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
        RETURNING page_id`,
      [input.runId, input.stepIndex, input.generation, input.code],
    );
    const pageId = failed.rows[0]?.page_id;
    if (!pageId) return { ok: false, reason: "stale_generation" } satisfies FailResult;
    await failRunFrom(client, runRow.owner, input.runId, input.stepIndex, pageId);
    return { ok: true, outcome: "failed" } satisfies FailResult;
  });
}

/**
 * 取消（冪等）。run を canceled、未完了の attempt を canceled にし、実行中の attempt は世代を進めて遅れて返る確定を拒否させる。
 * 未完了のサブページは wait。完了済みのサブページはそのまま。既に終わった run は何もしない。
 * 本人のその親ページの run でなければ null（404）。
 */
export async function cancelRun(db: StepRunsDb, owner: OwnerId, parentId: string, runId: string): Promise<StepRunView | null> {
  assertOwner(owner);
  if (!isPageId(parentId) || !isPageId(runId)) return null;
  return inTransaction<StepRunView | null>(db, async (client) => {
    const run = await client.query<{ state: RunState }>(
      "SELECT state FROM step_runs WHERE owner = $1 AND id = $2 AND parent = $3 FOR UPDATE",
      [owner, runId, parentId],
    );
    const runRow = run.rows[0];
    if (!runRow) return null;
    if (runRow.state === "queued" || runRow.state === "running") {
      await client.query(
        `UPDATE step_runs SET state = 'canceled', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE id = $1 AND state IN ('queued', 'running')`,
        [runId],
      );
      const canceled = await client.query<{ page_id: string }>(
        `UPDATE step_attempts
            SET state = 'canceled',
                generation = CASE WHEN state = 'running' THEN generation + 1 ELSE generation END,
                lease_until = NULL,
                finished_at = clock_timestamp()
          WHERE run_id = $1 AND state IN ('queued', 'pending', 'running')
          RETURNING page_id`,
        [runId],
      );
      await client.query(
        "UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])",
        [owner, canceled.rows.map((row) => row.page_id)],
      );
    }
    return loadRunView(client, owner, runId);
  });
}

/**
 * 期限切れの lease の掃除（定期の Scheduler から呼ぶ想定）。lease が切れた running を、`tries < MAX_TRIES` なら queued に戻し、
 * そうでなければ failed（`lease_expired`）にする。戻り値は積み直す対象（task の名前に世代を入れる）。
 */
export async function sweepExpiredLeases(db: StepRunsDb, options: { limit?: number } = {}): Promise<AttemptRef[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const expired = await db.query<{ run_id: string; step_index: number; generation: number }>(
    `SELECT run_id, step_index, generation FROM step_attempts
      WHERE state = 'running' AND lease_until < clock_timestamp()
      ORDER BY lease_until
      LIMIT $1`,
    [limit],
  );
  const requeue: AttemptRef[] = [];
  for (const candidate of expired.rows) {
    const ref = { runId: candidate.run_id, stepIndex: candidate.step_index, generation: candidate.generation };
    const outcome = await inTransaction(db, async (client) => {
      const run = await client.query<{ owner: string }>("SELECT owner FROM step_runs WHERE id = $1 FOR UPDATE", [ref.runId]);
      const owner = run.rows[0]?.owner;
      if (!owner) return "skipped" as const;
      // 生存確認が間に合った・別の世代になったものは触らない（条件はすべて UPDATE の中）
      const retried = await client.query<{ page_id: string }>(
        `UPDATE step_attempts SET state = 'queued', lease_until = NULL, heartbeat_at = NULL, error_code = 'lease_expired'
          WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
            AND lease_until < clock_timestamp() AND tries < $4
          RETURNING page_id`,
        [ref.runId, ref.stepIndex, ref.generation, MAX_TRIES],
      );
      const retryPage = retried.rows[0]?.page_id;
      if (retryPage) {
        await client.query("UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, retryPage]);
        return "requeued" as const;
      }
      const failed = await client.query<{ page_id: string }>(
        `UPDATE step_attempts SET state = 'failed', lease_until = NULL, error_code = 'lease_expired', finished_at = clock_timestamp()
          WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
            AND lease_until < clock_timestamp()
          RETURNING page_id`,
        [ref.runId, ref.stepIndex, ref.generation],
      );
      const failedPage = failed.rows[0]?.page_id;
      if (!failedPage) return "skipped" as const;
      await failRunFrom(client, owner, ref.runId, ref.stepIndex, failedPage);
      return "failed" as const;
    });
    if (outcome === "requeued") requeue.push(ref);
  }
  return requeue;
}

type StalePageRow = { id: string; blocks: Block[]; step_status: StepStatus | null; version: string };

/**
 * 前提変更の再計算。完了済み（done / stale）の段階について、今の基準（前の段階のサブページ・段階 0 は録音ページの blocks と指示文）
 * が記録した基準（最後に成功した attempt の input_basis）と違えば、その段階から後の done を stale にし、戻れば done に戻す。
 * 読むのは 1 つの snapshot、書くのは「読んだときから行が変わっていない（xmin が同じ）」ときだけ（並行する確定・作り直しを上書きしない）。
 * 戻り値は状態を変えたサブページの数。
 */
export async function refreshStale(db: StepRunsDb, owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<number> {
  assertOwner(owner);
  assertRecipe(recipe);
  if (!isPageId(parentId)) return 0;
  const pageIds = recipe.steps.map((_, index) => stepPageId(parentId, recipe.id, index));
  const client = await db.connect();
  let parentBlocks: Block[] | null;
  let pages: Map<string, StalePageRow>;
  let recorded: Map<number, string>;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const parent = await client.query<{ blocks: Block[] }>(
        "SELECT blocks FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL",
        [owner, parentId],
      );
      parentBlocks = parent.rows[0]?.blocks ?? null;
      const rows = await client.query<StalePageRow>(
        `SELECT id, blocks, step_status, xmin::text AS version FROM pages
          WHERE owner = $1 AND parent = $2 AND recipe = $3 AND kind = 'step' AND deleted_at IS NULL AND id = ANY($4::uuid[])`,
        [owner, parentId, recipe.id, pageIds],
      );
      pages = new Map(rows.rows.map((row) => [row.id, row]));
      const bases = await client.query<{ step_index: number; input_basis: string }>(
        `SELECT DISTINCT ON (a.step_index) a.step_index, a.input_basis
           FROM step_attempts a
           JOIN step_runs r ON r.id = a.run_id
          WHERE r.owner = $1 AND r.parent = $2 AND r.recipe = $3 AND a.state = 'succeeded' AND a.input_basis IS NOT NULL
          ORDER BY a.step_index, a.finished_at DESC`,
        [owner, parentId, recipe.id],
      );
      recorded = new Map(bases.rows.map((row) => [row.step_index, row.input_basis]));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
  if (parentBlocks === null) return 0;

  let changed = 0;
  let upstreamFresh = true;
  for (const [index, step] of recipe.steps.entries()) {
    const page = pages.get(pageIds[index]!);
    const status = page?.step_status ?? null;
    if (!page || (status !== "done" && status !== "stale")) {
      // 済みでない段階の後ろは、前提が定まっていない
      upstreamFresh = false;
      continue;
    }
    const previous = index === 0 ? parentBlocks : pages.get(pageIds[index - 1]!)?.blocks;
    const fresh: boolean = upstreamFresh && previous !== undefined && recorded.get(index) === computeBasis(previous, step.instruction);
    upstreamFresh = fresh;
    const want: StepStatus = fresh ? "done" : "stale";
    if (want === status) continue;
    const result = await db.query(
      `UPDATE pages SET step_status = $3
        WHERE owner = $1 AND id = $2 AND deleted_at IS NULL AND step_status = $4 AND xmin::text = $5`,
      [owner, page.id, want, status, page.version],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}
