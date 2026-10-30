/**
 * 入力のあと一定時間（既定 1 秒）静かになったら、たまった変更をまとめて保存する。
 * 日本語入力の変換中（composition）は保存を先へ送り、変換中の値を保存しない。
 * 版・オフライン保持・競合の扱いは #33。
 */

export type SaveState = "saved" | "saving" | "error";

export type AutosaveOptions<Patch extends object> = {
  delayMs?: number;
  save: (patch: Patch) => Promise<void>;
  isComposing: () => boolean;
  onState: (state: SaveState) => void;
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
    if (disposed || pending === null) return;
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
    } catch {
      inFlight = null;
      // 失敗した分は次の保存に持ち越す（新しい変更が優先）
      pending = { ...patch, ...(pending ?? {}) };
      options.onState("error");
    }
  }

  return {
    change(patch) {
      pending = { ...(pending ?? {}), ...patch } as Patch;
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
