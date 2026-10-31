/**
 * 文字起こしの実行の呼び出し口（#36 段 2b）。開始の API が run を作ったあとに dispatch(runId) を呼ぶ。
 *
 * 今の実装は `inline` だけ（開発と CI 用）: 同じプロセスの中で、応答を返したあと（setImmediate）に実行（run.ts の executeRun）を
 * 非同期に走らせる。要求は待たない。**本番（`NODE_ENV=production`）では inline を使わない**（呼び出し口が無い＝開始の API は 503
 * `transcription_unavailable`）。Cloud Run は応答のあとに CPU を絞るので、同じプロセスで長い文字起こしを続けられる保証が無いため。
 * 本番の口（Cloud Tasks に積み、内向きの worker が run の id で executeRun を呼ぶ。OIDC は #37 の側）ができたら、ここに足す。
 */

export type TranscriptionDispatcher = {
  readonly kind: "inline";
  /** run の実行を始める（積む）。積めなければ reject（呼び出し側が run を failed（internal）にする）。 */
  dispatch(runId: string): Promise<void>;
};

/** 呼び出し口の方式。本番は null（inline を受け付けない）。 */
export function resolveDispatcherKind(env: Readonly<Record<string, string | undefined>>): "inline" | null {
  return env.NODE_ENV === "production" ? null : "inline";
}

export type InlineDispatcherDeps = {
  /** run を実行する（executeRun。例外は外へ出さない約束だが、出たら failQueued と同じ扱いにする）。 */
  execute: (runId: string) => Promise<unknown>;
  /** 実行が想定外に失敗したとき: claim される前の run（世代 0）を failed（internal）にする（claim 後の失敗は executeRun が自分で失敗にする）。 */
  failQueued: (runId: string) => Promise<unknown>;
  /** 後で走らせる（既定は setImmediate。テストで差し替える）。 */
  schedule?: (task: () => void) => void;
  /** 想定外の失敗の知らせ（既定はログに名前だけを書く）。 */
  onError?: (error: unknown) => void;
};

function logError(error: unknown): void {
  console.error("editor-web: inline transcription failed", { name: error instanceof Error ? error.name : "unknown" });
}

/** inline の呼び出し口（開発と CI だけ）。 */
export function createInlineDispatcher(deps: InlineDispatcherDeps): TranscriptionDispatcher {
  const schedule = deps.schedule ?? ((task: () => void) => void setImmediate(task));
  const onError = deps.onError ?? logError;
  return {
    kind: "inline",
    async dispatch(runId: string): Promise<void> {
      schedule(() => {
        deps.execute(runId).catch(async (error: unknown) => {
          // 握りつぶさない: 知らせて、まだ claim されていなければ run を失敗にする（「もう一度」ができるように）
          onError(error);
          await deps.failQueued(runId).catch((failure: unknown) => onError(failure));
        });
      });
    },
  };
}
