import {
  cancelRun,
  claimAttempt,
  commitAttempt,
  createRun,
  failAttempt,
  heartbeatAttempt,
  listQueuedAttempts,
  listRun,
  readStepInput,
  refreshStale,
  sweepExpiredLeases,
  type AttemptRef,
  type ClaimResult,
  type CommitInput,
  type CommitResult,
  type CreateRunInput,
  type CreateRunResult,
  type FailInput,
  type FailResult,
  type OwnerId,
  type StepClaim,
  type StepInput,
  type StepRecipe,
  type StepRunView,
  type StepRunsDb,
} from "@niho/editor-store";

/**
 * 手順の層が使う store の操作。実体は packages/editor-store の step-runs.ts に Pool を渡したもの（`pgStepRunStore`）。
 * テストではメモリの実装（memory-store.ts）に差し替える。
 */
export type StepRunStore = {
  createRun(owner: OwnerId, parentId: string, input: CreateRunInput): Promise<CreateRunResult>;
  listRun(owner: OwnerId, parentId: string): Promise<{ run: StepRunView | null } | null>;
  cancelRun(owner: OwnerId, parentId: string, runId: string): Promise<StepRunView | null>;
  refreshStale(owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<number>;
  claimAttempt(runId: string, stepIndex: number, options?: { leaseSeconds?: number }): Promise<ClaimResult>;
  heartbeatAttempt(ref: AttemptRef, options?: { leaseSeconds?: number }): Promise<boolean>;
  readStepInput(claim: StepClaim): Promise<StepInput | null>;
  commitAttempt(input: CommitInput): Promise<CommitResult>;
  failAttempt(input: FailInput): Promise<FailResult>;
};

export function pgStepRunStore(db: StepRunsDb): StepRunStore {
  return {
    createRun: (owner, parentId, input) => createRun(db, owner, parentId, input),
    listRun: (owner, parentId) => listRun(db, owner, parentId),
    cancelRun: (owner, parentId, runId) => cancelRun(db, owner, parentId, runId),
    refreshStale: (owner, parentId, recipe) => refreshStale(db, owner, parentId, recipe),
    claimAttempt: (runId, stepIndex, options) => claimAttempt(db, runId, stepIndex, options),
    heartbeatAttempt: (ref, options) => heartbeatAttempt(db, ref, options),
    readStepInput: (claim) => readStepInput(db, claim),
    commitAttempt: (input) => commitAttempt(db, input),
    failAttempt: (input) => failAttempt(db, input),
  };
}

/** 定期の掃除（worker の sweep の route）が使う操作。期限切れの lease を queued に戻し、queued の一覧を読む。 */
export type StepSweepStore = {
  sweepExpiredLeases(options?: { limit?: number }): Promise<AttemptRef[]>;
  listQueuedAttempts(options?: { limit?: number; after?: Pick<AttemptRef, "runId" | "stepIndex"> }): Promise<AttemptRef[]>;
};

export function pgStepSweepStore(db: StepRunsDb): StepSweepStore {
  return {
    sweepExpiredLeases: (options) => sweepExpiredLeases(db, options),
    listQueuedAttempts: (options) => listQueuedAttempts(db, options),
  };
}
