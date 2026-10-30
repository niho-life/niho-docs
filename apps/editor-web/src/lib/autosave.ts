/**
 * 入力のあと一定時間（既定 1 秒）静かになったら、たまった変更をまとめて保存する。
 * 日本語入力の変換中（composition）は保存を先へ送り、変換中の値を保存しない。保存は 1 つずつ（直列）。
 * `stopOn` が真を返す失敗（別の画面で保存された競合など）では、それ以後は保存を送らない（`stopped`）。
 * 止まったあとの変更も捨てずにため続ける（再送の判断・オフライン保持は #33 の次の PR）。
 */

export type SaveState = "saved" | "saving" | "error" | "stopped";

export type AutosaveOptions<Patch extends object> = {
  delayMs?: number;
  save: (patch: Patch) => Promise<void>;
  isComposing: () => boolean;
  onState: (state: SaveState) => void;
  /** この失敗のあとは自動保存を止める（再送しても同じく失敗し、上書きの判断が要るもの）。 */
  stopOn?: (error: unknown) => boolean;
};

export type Autosave<Patch extends object> = {
  /** 変更を足し、保存の時計をかけ直す。 */
  change: (patch: Patch) => void;
  /** 時計を待たずに今たまっている変更を保存する。 */
  flush: () => Promise<void>;
  dispose: () => void;
};

export const AUTOSAVE_DELAY_MS = 1000;

export function createAutosave<Patch extends object>(options: AutosaveOptions<Patch>): Autosave<Patch> {
  const delay = options.delayMs ?? AUTOSAVE_DELAY_MS;
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!disposed) timer = setTimeout(() => void flush(), delay);
  };

  async function flush(): Promise<void> {
    clear();
    if (disposed || stopped || pending === null) return;
    if (options.isComposing() || inFlight) {
      // 変換の確定後・前の保存の後にもう一度
      schedule();
      return;
    }
    const patch = pending;
    pending = null;
    options.onState("saving");
    inFlight = options.save(patch);
    try {
      await inFlight;
      inFlight = null;
      if (pending !== null) schedule();
      else options.onState("saved");
    } catch (error) {
      inFlight = null;
      // 失敗した分は次の保存に持ち越す（新しい変更が優先）
      pending = { ...patch, ...(pending ?? {}) };
      if (options.stopOn?.(error) === true) {
        stopped = true;
        clear();
        options.onState("stopped");
        return;
      }
      options.onState("error");
    }
  }

  return {
    change(patch) {
      pending = { ...(pending ?? {}), ...patch } as Patch;
      // 止まったあとは送らずにためるだけ
      if (stopped) return;
      options.onState("saving");
      schedule();
    },
    flush,
    dispose() {
      disposed = true;
      clear();
    },
  };
}
