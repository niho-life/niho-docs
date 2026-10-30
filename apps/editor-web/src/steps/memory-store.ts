import { randomUUID } from "node:crypto";
import {
  DEFAULT_LEASE_SECONDS,
  MAX_TRIES,
  computeBasis,
  isPageId,
  stepPageId,
  type AttemptState,
  type Block,
  type PageKind,
  type RunState,
  type StepRunView,
  type StepStatus,
} from "@niho/editor-store";
import type { StepRunStore } from "./store";

type MemoryPage = {
  id: string;
  owner: string;
  kind: PageKind;
  title: string;
  blocks: Block[];
  parent: string | null;
  recipe: string | null;
  stepStatus: StepStatus | null;
  deleted: boolean;
};

type MemoryAttempt = {
  stepIndex: number;
  stepId: string;
  pageId: string;
  state: AttemptState;
  generation: number;
  tries: number;
  leaseUntil: number | null;
  errorCode: string | null;
  inputBasis: string | null;
  finishedAt: number | null;
};

type MemoryRun = {
  id: string;
  owner: string;
  parent: string;
  recipe: string;
  fromStep: number;
  state: RunState;
  key: string | null;
  seq: number;
  attempts: MemoryAttempt[];
};

const ACTIVE: readonly RunState[] = ["queued", "running"];

/**
 * メモリの中の StepRunStore（テスト用。packages/editor-store の step-runs.ts と同じ約束の小さな写し）。
 * 1 つの呼び出しの中で await しないので、各操作はそのまま不可分になる。
 */
export class MemoryStepRunStore implements StepRunStore {
  readonly pages = new Map<string, MemoryPage>();
  readonly runs = new Map<string, MemoryRun>();
  #seq = 0;
  #clock = 0;

  /** 単調に進む時刻（finishedAt の並びに使う）。 */
  #now(): number {
    this.#clock = Math.max(this.#clock + 1, Date.now());
    return this.#clock;
  }

  addPage(owner: string, page: { kind?: PageKind; blocks?: Block[] } = {}): string {
    const id = randomUUID();
    this.pages.set(id, { id, owner, kind: page.kind ?? "note", title: "", blocks: page.blocks ?? [], parent: null, recipe: null, stepStatus: null, deleted: false });
    return id;
  }

  #page(owner: string, id: string | null): MemoryPage | null {
    if (id === null) return null;
    const page = this.pages.get(id);
    return page && page.owner === owner && !page.deleted ? page : null;
  }

  #setStatus(owner: string, pageId: string, status: StepStatus): void {
    const page = this.#page(owner, pageId);
    if (page) page.stepStatus = status;
  }

  #view(run: MemoryRun): StepRunView {
    return {
      id: run.id,
      recipe: run.recipe,
      state: run.state,
      fromStep: run.fromStep,
      steps: run.attempts.map((attempt) => ({
        index: attempt.stepIndex,
        stepId: attempt.stepId,
        state: attempt.state,
        pageId: attempt.pageId,
        stepStatus: this.#page(run.owner, attempt.pageId)?.stepStatus ?? null,
        tries: attempt.tries,
        errorCode: attempt.errorCode,
      })),
    };
  }

  #attempt(runId: string, stepIndex: number): { run: MemoryRun; attempt: MemoryAttempt } | null {
    const run = this.runs.get(runId);
    const attempt = run?.attempts[stepIndex];
    return run && attempt ? { run, attempt } : null;
  }

  #failRunFrom(run: MemoryRun, stepIndex: number): void {
    const now = this.#now();
    for (const later of run.attempts.slice(stepIndex + 1)) {
      if (later.state === "pending" || later.state === "queued") {
        later.state = "canceled";
        later.finishedAt = now;
        this.#setStatus(run.owner, later.pageId, "wait");
      }
    }
    run.state = "failed";
  }

  createRun: StepRunStore["createRun"] = async (owner, parentId, input) => {
    const { recipe } = input;
    const fromStep = input.fromStep ?? 0;
    if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep >= recipe.steps.length) throw new RangeError("fromStep is out of range");
    if (!isPageId(parentId)) return { status: "not_found" };
    const parent = this.#page(owner, parentId);
    if (!parent || parent.kind !== "rec") return { status: "not_found" };
    const key = input.idempotencyKey ?? null;
    const replay = key === null ? undefined : [...this.runs.values()].find((run) => run.owner === owner && run.key === key);
    if (replay) return { status: "existing", run: this.#view(replay) };
    if ([...this.runs.values()].some((run) => run.owner === owner && run.parent === parentId && ACTIVE.includes(run.state))) {
      return { status: "run_in_progress" };
    }
    const pageIds = recipe.steps.map((_, index) => stepPageId(parentId, recipe.id, index));
    if (pageIds.slice(0, fromStep).some((id) => this.#page(owner, id)?.stepStatus !== "done")) return { status: "invalid_from_step" };
    for (const [index, step] of recipe.steps.entries()) {
      if (index < fromStep) continue;
      const id = pageIds[index]!;
      const existing = this.pages.get(id);
      if (existing) {
        existing.deleted = false;
        existing.stepStatus = "wait";
      } else {
        this.pages.set(id, { id, owner, kind: "step", title: step.name, blocks: [], parent: parentId, recipe: recipe.id, stepStatus: "wait", deleted: false });
      }
    }
    const run: MemoryRun = {
      id: randomUUID(),
      owner,
      parent: parentId,
      recipe: recipe.id,
      fromStep,
      state: "queued",
      key,
      seq: ++this.#seq,
      attempts: recipe.steps.map((step, index) => ({
        stepIndex: index,
        stepId: step.id,
        pageId: pageIds[index]!,
        state: index < fromStep ? "reused" : index === fromStep ? "queued" : "pending",
        generation: 0,
        tries: 0,
        leaseUntil: null,
        errorCode: null,
        inputBasis: null,
        finishedAt: index < fromStep ? this.#now() : null,
      })),
    };
    this.runs.set(run.id, run);
    return { status: "created", run: this.#view(run) };
  };

  listRun: StepRunStore["listRun"] = async (owner, parentId) => {
    if (!isPageId(parentId) || !this.#page(owner, parentId)) return null;
    const latest = [...this.runs.values()].filter((run) => run.owner === owner && run.parent === parentId).sort((a, b) => b.seq - a.seq)[0];
    return { run: latest ? this.#view(latest) : null };
  };

  cancelRun: StepRunStore["cancelRun"] = async (owner, parentId, runId) => {
    const run = this.runs.get(runId);
    if (!run || run.owner !== owner || run.parent !== parentId) return null;
    if (ACTIVE.includes(run.state)) {
      run.state = "canceled";
      for (const attempt of run.attempts) {
        if (attempt.state === "queued" || attempt.state === "pending" || attempt.state === "running") {
          if (attempt.state === "running") attempt.generation += 1;
          attempt.state = "canceled";
          attempt.leaseUntil = null;
          attempt.finishedAt = this.#now();
          this.#setStatus(owner, attempt.pageId, "wait");
        }
      }
    }
    return this.#view(run);
  };

  refreshStale: StepRunStore["refreshStale"] = async (owner, parentId, recipe) => {
    const parent = isPageId(parentId) ? this.#page(owner, parentId) : null;
    if (!parent) return 0;
    const recorded = new Map<number, { basis: string; at: number }>();
    for (const run of this.runs.values()) {
      if (run.owner !== owner || run.parent !== parentId || run.recipe !== recipe.id) continue;
      for (const attempt of run.attempts) {
        const previous = recorded.get(attempt.stepIndex);
        if (attempt.state === "succeeded" && attempt.inputBasis && (!previous || (attempt.finishedAt ?? 0) > previous.at)) {
          recorded.set(attempt.stepIndex, { basis: attempt.inputBasis, at: attempt.finishedAt ?? 0 });
        }
      }
    }
    let changed = 0;
    let upstreamFresh = true;
    for (const [index, step] of recipe.steps.entries()) {
      const page = this.#page(owner, stepPageId(parentId, recipe.id, index));
      if (!page || (page.stepStatus !== "done" && page.stepStatus !== "stale")) {
        upstreamFresh = false;
        continue;
      }
      const previous = index === 0 ? parent.blocks : this.#page(owner, stepPageId(parentId, recipe.id, index - 1))?.blocks;
      const fresh: boolean = upstreamFresh && previous !== undefined && recorded.get(index)?.basis === computeBasis(previous, step.instruction);
      upstreamFresh = fresh;
      const want: StepStatus = fresh ? "done" : "stale";
      if (page.stepStatus !== want) {
        page.stepStatus = want;
        changed += 1;
      }
    }
    return changed;
  };

  claimAttempt: StepRunStore["claimAttempt"] = async (runId, stepIndex, options = {}) => {
    const run = this.runs.get(runId);
    if (!run || !ACTIVE.includes(run.state)) return { ok: false, reason: "run_inactive" };
    const attempt = run.attempts[stepIndex];
    if (!attempt || attempt.state !== "queued") return { ok: false, reason: "not_queued" };
    const previous = stepIndex === 0 ? null : run.attempts[stepIndex - 1]!;
    if (previous && previous.state !== "succeeded" && previous.state !== "reused") return { ok: false, reason: "superseded" };
    attempt.state = "running";
    attempt.generation += 1;
    attempt.tries += 1;
    attempt.leaseUntil = Date.now() + (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    attempt.errorCode = null;
    run.state = "running";
    this.#setStatus(run.owner, attempt.pageId, "run");
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: run.owner,
        parentId: run.parent,
        recipe: run.recipe,
        stepId: attempt.stepId,
        pageId: attempt.pageId,
        previousPageId: previous?.pageId ?? null,
      },
    };
  };

  heartbeatAttempt: StepRunStore["heartbeatAttempt"] = async (ref, options = {}) => {
    const found = this.#attempt(ref.runId, ref.stepIndex);
    if (!found || found.attempt.state !== "running" || found.attempt.generation !== ref.generation) return false;
    found.attempt.leaseUntil = Date.now() + (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    return true;
  };

  readStepInput: StepRunStore["readStepInput"] = async (claim) => {
    const parent = this.#page(claim.owner, claim.parentId);
    if (!parent) return null;
    if (claim.previousPageId === null) return { parentBlocks: parent.blocks, previousBlocks: null };
    const previous = this.#page(claim.owner, claim.previousPageId);
    return previous ? { parentBlocks: parent.blocks, previousBlocks: previous.blocks } : null;
  };

  commitAttempt: StepRunStore["commitAttempt"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    if (!found || found.run.state !== "running" || found.attempt.state !== "running" || found.attempt.generation !== input.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    const { run, attempt } = found;
    const page = this.#page(run.owner, attempt.pageId);
    if (!page) return { ok: false, reason: "page_missing" };
    page.blocks = [...input.blocks];
    page.stepStatus = "done";
    attempt.state = "succeeded";
    attempt.inputBasis = input.inputBasis;
    attempt.leaseUntil = null;
    attempt.finishedAt = this.#now();
    const next = run.attempts[input.stepIndex + 1];
    if (next && next.state === "pending") {
      next.state = "queued";
      return { ok: true, next: next.stepIndex };
    }
    run.state = "succeeded";
    return { ok: true, next: null };
  };

  failAttempt: StepRunStore["failAttempt"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    if (!found || found.run.state !== "running" || found.attempt.state !== "running" || found.attempt.generation !== input.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    const { run, attempt } = found;
    attempt.errorCode = input.code;
    attempt.leaseUntil = null;
    if (input.retryable && attempt.tries < MAX_TRIES) {
      attempt.state = "queued";
      this.#setStatus(run.owner, attempt.pageId, "wait");
      return { ok: true, outcome: "retry", generation: attempt.generation, tries: attempt.tries };
    }
    attempt.state = "failed";
    attempt.finishedAt = this.#now();
    this.#setStatus(run.owner, attempt.pageId, "failed");
    this.#failRunFrom(run, input.stepIndex);
    return { ok: true, outcome: "failed" };
  };
}
