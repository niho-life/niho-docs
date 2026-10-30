/**
 * 入力のあと一定時間（既定 1 秒）静かになったら、たまった変更をまとめて保存する。
 * 日本語入力の変換中（composition）は保存を先へ送り、変換中の値を保存しない。保存は 1 つずつ（直列）。
 *
 * 失敗は `classify` で分ける（既定は `error`）。
 * - `offline`・`error`: 変更を持ったまま、指数バックオフ（5s→10s→20s→40s→60s で頭打ち）と `online` で送り直す。
 *   新しい入力があれば、待ちを待たずに入力の 1 秒後に送る。
 * - `signedOut`: 送り直さない（ログインし直すまで同じ失敗になる）。新しい入力・`flush` のときだけもう一度送る。
 * - `stopped`: それ以後は送らない（別の画面で保存された競合など。上書きの判断が要る）。`resume` で再開する。
 * どの失敗でも、送れなかった変更は捨てずにため続ける。
 *
 * 変更の値は「値を取る関数」でも渡せる（`change({ blocks: () => editor.getJSON().content })`）。
 * 関数は送る直前にだけ呼ぶので、入力のたびに重い値を作らない。
 */

export type SaveFailure = "offline" | "error" | "signedOut" | "stopped";
export type SaveState = "saved" | "saving" | SaveFailure;

/** 値か、値を取る関数（送る直前に呼ぶ）。Patch の値そのものに関数は使わない。 */
export type Lazy<T> = T | (() => T);
export type LazyPatch<Patch extends object> = { [K in keyof Patch]?: Lazy<Patch[K]> };

export type SaveContext = {
  /** タブを閉じる・隠れる瞬間の保存（`fetch` の `keepalive`）。 */
  keepalive: boolean;
};

export type AutosaveOptions<Patch extends object> = {
  delayMs?: number;
  save: (patch: Patch, context: SaveContext) => Promise<void>;
  isComposing: () => boolean;
  /** 状態が変わったとき（失敗のときは毎回、その失敗と一緒に）。 */
  onState: (state: SaveState, error?: unknown) => void;
  /** 失敗の分類（既定は `error`）。 */
  classify?: (error: unknown) => SaveFailure;
  /** 保存が成功した。`idle` は、その保存のあいだに新しい変更が無かった（今の内容が全てサーバーにある）。 */
  onSaved?: (idle: boolean) => void;
  /** 送り直しの間隔（失敗の回数ごと。最後の値で頭打ち）。 */
  retryDelaysMs?: readonly number[];
  /** ネットワークが戻った知らせ（既定は window の `online`）。 */
  subscribeOnline?: (listener: () => void) => () => void;
};

export type FlushOptions = { keepalive?: boolean };

export type Autosave<Patch extends object> = {
  /** 変更を足し、保存の時計をかけ直す。 */
  change: (patch: LazyPatch<Patch>) => void;
  /** 時計を待たずに今たまっている変更を保存する（変換中・前の保存の最中は、その後へ送る）。 */
  flush: (options?: FlushOptions) => Promise<void>;
  /** 自動保存を止める（開いたときに競合していた下書きなど）。変更はため続ける。 */
  stop: () => void;
  /** 止まった自動保存を再開し、たまった変更をすぐ送る（「この内容で上書き」）。 */
  resume: () => void;
  /** まだサーバーに届いていない変更があるか。 */
  hasPending: () => boolean;
  /**
   * 画面を離れる: たまった変更を今（前の保存の最中ならその直後に）1 回だけ送り、以後は何もしない（再送しない）。
   * 止まっているときは送らない。
   */
  close: () => void;
  /** 何も送らずに止める。 */
  dispose: () => void;
};

export const AUTOSAVE_DELAY_MS = 1000;
export const RETRY_DELAYS_MS: readonly number[] = [5000, 10_000, 20_000, 40_000, 60_000];

function resolvePatch<Patch extends object>(lazy: LazyPatch<Patch>): Patch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lazy)) out[key] = typeof value === "function" ? (value as () => unknown)() : value;
  return out as Patch;
}

function defaultSubscribeOnline(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", listener);
  return () => window.removeEventListener("online", listener);
}

export function createAutosave<Patch extends object>(options: AutosaveOptions<Patch>): Autosave<Patch> {
  const delay = options.delayMs ?? AUTOSAVE_DELAY_MS;
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const classify = options.classify ?? (() => "error" as const);
  let pending: LazyPatch<Patch> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let disposed = false;
  let closing = false;
  let stopped = false;
  let failures = 0;
  let state: SaveState = "saved";

  const setState = (next: SaveState, error?: unknown) => {
    if (next === state && error === undefined) return;
    state = next;
    options.onState(next, error);
  };
  const inFailure = () => state === "offline" || state === "error" || state === "signedOut";

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const later = (ms: number) => {
    clear();
    if (!disposed && !closing) timer = setTimeout(() => void flush(), ms);
  };
  const retryDelay = () => retryDelays[Math.min(failures, retryDelays.length) - 1] ?? delay;

  const unsubscribeOnline = (options.subscribeOnline ?? defaultSubscribeOnline)(() => {
    if (disposed || closing || stopped) return;
    if (state !== "offline" && state !== "error") return;
    // 戻ったらすぐ送る（バックオフは最初から数え直す）
    failures = 0;
    void flush();
  });

  async function flush(flushOptions: FlushOptions = {}): Promise<void> {
    if (disposed) return;
    clear();
    if (stopped || pending === null) return;
    if (inFlight) {
      // 前の保存の後にもう一度（閉じるときは、前の保存が終わったところで送る）
      later(delay);
      return;
    }
    if (options.isComposing()) {
      // 変換の確定後にもう一度（閉じるときは送らない。下書きに残っている分が最後の守り）
      later(delay);
      return;
    }
    const lazy = pending;
    pending = null;
    let patch: Patch;
    try {
      patch = resolvePatch(lazy);
    } catch (error) {
      pending = { ...lazy, ...(pending ?? {}) };
      setState("error", error);
      return;
    }
    if (!inFailure()) setState("saving");
    inFlight = true;
    try {
      await options.save(patch, { keepalive: flushOptions.keepalive === true });
    } catch (error) {
      inFlight = false;
      // 失敗した分は次の保存に持ち越す（新しい変更が優先）
      pending = { ...(patch as LazyPatch<Patch>), ...(pending ?? {}) };
      if (disposed) return;
      const failure = classify(error);
      if (failure === "stopped") {
        stopped = true;
        clear();
        setState("stopped", error);
        return;
      }
      setState(failure, error);
      if (closing || failure === "signedOut") return;
      failures += 1;
      // 保存の最中に入力があれば、その入力の時計（1 秒）を優先する
      if (timer === null) later(retryDelay());
      return;
    }
    inFlight = false;
    failures = 0;
    const idle = pending === null;
    options.onSaved?.(idle);
    if (disposed) return;
    if (closing) {
      if (!idle) void flush();
      return;
    }
    if (idle) {
      setState("saved");
    } else {
      setState("saving");
      if (timer === null) later(delay);
    }
  }

  return {
    change(patch) {
      pending = { ...(pending ?? {}), ...patch };
      // 止まったあとは送らずにためるだけ
      if (disposed || closing || stopped) return;
      // 失敗の表示（オフラインなど）は、送れるまでそのまま出しておく
      if (!inFailure()) setState("saving");
      later(delay);
    },
    flush,
    stop() {
      if (disposed || closing) return;
      stopped = true;
      clear();
      setState("stopped");
    },
    resume() {
      if (disposed || closing) return;
      stopped = false;
      failures = 0;
      if (pending === null && !inFlight) {
        setState("saved");
        return;
      }
      setState("saving");
      void flush();
    },
    hasPending: () => pending !== null || inFlight,
    close() {
      if (disposed || closing) return;
      // 画面を離れたあとは値を取る関数（エディタ）が使えなくなるので、今の値にしておく
      if (pending !== null) {
        try {
          pending = resolvePatch(pending) as LazyPatch<Patch>;
        } catch {
          // 値を取れなければそのまま（送るときにもう一度試して、だめなら error。下書きが残る）
        }
      }
      closing = true;
      clear();
      unsubscribeOnline();
      void flush();
    },
    dispose() {
      disposed = true;
      clear();
      unsubscribeOnline();
    },
  };
}
