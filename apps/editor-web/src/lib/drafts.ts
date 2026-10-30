/**
 * 端末の下書き（IndexedDB）。正本はサーバーで、ここはサーバーへ届くまで一時的に持っているだけ（Issue #33・#30 §2）。
 * ページごと（key は pageId）に `{ baseRevision, title, blocks, savedAt }` を 1 つ持つ。
 * 入力のたびに（300ms のまとめ。変換中は書かない）書き、サーバーへの保存がその内容で成功したら消す。
 * IndexedDB が使えない・容量を超えた・例外のときは、画面を壊さず「端末への保持なし」として続ける（`onResult` で知らせる）。
 * 容量の管理・「この端末で作業する」の選択・同期は持たない（#50）。
 */

import { sameContent } from "./page-save";

export type PageDraft = {
  /** この題名・本文がもとにしているサーバーの revision。 */
  baseRevision: number;
  title: string;
  blocks: unknown[];
  /** 端末に書いた時刻（ISO 8601）。 */
  savedAt: string;
};

/**
 * 下書きの置き場。呼んだ順に適用される（put のあとに呼んだ delete はその put を消し、delete のあとの put は残る）。
 * 失敗は reject で返す。
 */
export type DraftStorage = {
  get: (pageId: string) => Promise<PageDraft | null>;
  put: (pageId: string, draft: PageDraft) => Promise<void>;
  /** 消す。`onlyIf` があれば、その時点で入っている下書きが条件に合うときだけ消す（読むのと消すのは 1 つの transaction）。 */
  delete: (pageId: string, onlyIf?: (stored: PageDraft) => boolean) => Promise<void>;
};

export const DRAFT_DB_NAME = "niho-editor";
export const DRAFT_STORE = "page-drafts";
const DRAFT_DB_VERSION = 1;

function isPageDraft(value: unknown): value is PageDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.baseRevision === "number" &&
    Number.isSafeInteger(draft.baseRevision) &&
    draft.baseRevision > 0 &&
    typeof draft.title === "string" &&
    Array.isArray(draft.blocks) &&
    typeof draft.savedAt === "string"
  );
}

function browserIndexedDb(): IDBFactory | undefined {
  try {
    return typeof indexedDB === "undefined" ? undefined : indexedDB;
  } catch {
    // 読むだけで例外になる環境（保存を禁じた iframe など）
    return undefined;
  }
}

/** 素の IndexedDB の下書きの置き場。IndexedDB が無ければ null（端末への保持なし）。 */
export function createIndexedDbDraftStorage(factory: IDBFactory | undefined = browserIndexedDb()): DraftStorage | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // 別のタブが版を上げる・閉じられたときは、次の操作で開き直す
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        db.onclose = () => {
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  // 操作は開いた DB に同期的に transaction を作る（readwrite の transaction は作った順に適用される）
  const run = <T>(mode: IDBTransactionMode, operate: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(DRAFT_STORE, mode);
          const request = operate(transaction.objectStore(DRAFT_STORE));
          transaction.oncomplete = () => resolve(request.result);
          transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("indexedDB transaction aborted"));
        }),
    );

  return {
    async get(pageId) {
      const value: unknown = await run("readonly", (store) => store.get(pageId));
      return isPageDraft(value) ? value : null;
    },
    async put(pageId, draft) {
      await run("readwrite", (store) => store.put(draft, pageId));
    },
    async delete(pageId, onlyIf) {
      await run("readwrite", (store) => {
        if (!onlyIf) return store.delete(pageId);
        const read = store.get(pageId);
        read.onsuccess = () => {
          const stored: unknown = read.result;
          if (isPageDraft(stored) && onlyIf(stored)) store.delete(pageId);
        };
        return read;
      });
    },
  };
}

export const DRAFT_DELAY_MS = 300;
/** 開いたときに下書きを読む上限。超えたら、この画面では端末に書かない（読めていない下書きを上書きしない）。 */
export const DRAFT_READ_TIMEOUT_MS = 2000;

export type DraftReadResult = { ok: true; draft: PageDraft | null } | { ok: false; error: unknown };

/** 下書きを読む（失敗・時間切れは ok: false）。 */
export function readDraft(storage: DraftStorage, pageId: string, timeoutMs: number = DRAFT_READ_TIMEOUT_MS): Promise<DraftReadResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: new Error("draft read timed out") }), timeoutMs);
    let started: Promise<PageDraft | null>;
    try {
      started = storage.get(pageId);
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (draft) => {
        clearTimeout(timer);
        resolve({ ok: true, draft });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

export type RestoreDecision =
  /** 下書きが無い。 */
  | { action: "none" }
  /** サーバーのページと同じ内容。載せずに消す。 */
  | { action: "discard" }
  /** サーバーの revision のまま。下書きを載せて保存し直す。 */
  | { action: "load"; draft: PageDraft }
  /** サーバーが先へ進んでいる。下書きを載せたまま競合の帯を出す（下書きは消さない）。 */
  | { action: "conflict"; draft: PageDraft };

/** 開いたときの下書きの扱い。 */
export function decideRestore(draft: PageDraft | null, server: { title: string; blocks: unknown[]; revision: number }): RestoreDecision {
  if (!draft) return { action: "none" };
  if (sameContent(draft, server)) return { action: "discard" };
  return draft.baseRevision === server.revision ? { action: "load", draft } : { action: "conflict", draft };
}

export type DraftKeeper = {
  /** 内容が変わった（300ms のまとめのあとに書く）。 */
  touch: () => void;
  /**
   * まとめを待たずに今書く（タブを閉じる・隠れる瞬間）。書く必要が無い・変換中なら何もしない。
   * `force` は、前に書いた分があっても書き直す（まだ保存されていない変更があるとき。別のタブに消された下書きを戻す）。
   */
  writeNow: (force?: boolean) => void;
  /** 開いたときに載せた下書きを、この画面が書いたものとして扱う（保存できたら消す）。 */
  adopt: (draft: PageDraft) => void;
  /** 変換が確定した（変換中で先へ送った書き込みを、すぐ書く）。 */
  compositionEnded: () => void;
  /**
   * 今の内容がサーバーに保存された。書く予定を取り消して下書きを消す。
   * 消すのはこの画面が書いた（または載せた）下書きだけ（同じページを開いた別のタブの下書きは消さない）。
   */
  discard: () => void;
  /** 以後、端末に書かない（読めなかった下書きを上書きしない）。 */
  disable: () => void;
  /** 時計を止める（`writeNow`・`discard` はそのあとも使える）。 */
  dispose: () => void;
  /** 始めた書き込み・削除が全て終わるのを待つ（テスト用）。 */
  settled: () => Promise<void>;
};

export function createDraftKeeper(options: {
  storage: DraftStorage;
  pageId: string;
  /** 今の題名・本文・もとにしている revision（書く直前にだけ呼ぶ）。 */
  read: () => Omit<PageDraft, "savedAt">;
  isComposing: () => boolean;
  /** 端末への書き込み・削除の結果（失敗は「端末への保持なし」）。 */
  onResult: (ok: boolean, error?: unknown) => void;
  delayMs?: number;
}): DraftKeeper {
  const delay = options.delayMs ?? DRAFT_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let disabled = false;
  let disposed = false;
  let last: Promise<void> = Promise.resolve();
  // この画面が書いた・載せた下書きの印（savedAt）
  const mine = new Set<string>();

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const later = (ms: number) => {
    clear();
    if (!disposed && !disabled) timer = setTimeout(fire, ms);
  };
  const track = (operate: () => Promise<void>, onFailure?: () => void, onSuccess?: () => void) => {
    let started: Promise<void>;
    try {
      started = operate();
    } catch (error) {
      started = Promise.reject(error);
    }
    const done = started.then(
      () => {
        onSuccess?.();
        options.onResult(true);
      },
      (error: unknown) => {
        onFailure?.();
        options.onResult(false, error);
      },
    );
    last = last.then(() => done);
  };
  const write = () => {
    clear();
    if (disabled) return;
    dirty = false;
    let draft: PageDraft;
    try {
      draft = { ...options.read(), savedAt: new Date().toISOString() };
    } catch (error) {
      dirty = true;
      options.onResult(false, error);
      return;
    }
    mine.add(draft.savedAt);
    // 書けなかったら、次の機会（writeNow・次の入力）にもう一度書く
    track(
      () => options.storage.put(options.pageId, draft),
      () => {
        dirty = true;
      },
    );
  };
  function fire() {
    timer = null;
    if (!dirty || disabled) return;
    // 変換中の値は書かない（確定したら compositionEnded ですぐ書く）
    if (options.isComposing()) {
      later(delay);
      return;
    }
    write();
  }

  return {
    touch() {
      if (disabled) return;
      dirty = true;
      later(delay);
    },
    writeNow(force = false) {
      if (disabled || !(dirty || force) || options.isComposing()) return;
      write();
    },
    adopt(draft) {
      mine.add(draft.savedAt);
    },
    compositionEnded() {
      if (dirty && timer !== null) later(0);
    },
    discard() {
      clear();
      dirty = false;
      if (disabled || mine.size === 0) return;
      const written = new Set(mine);
      track(
        () => options.storage.delete(options.pageId, (stored) => written.has(stored.savedAt)),
        undefined,
        // 消し終えたら、それまでの印は要らない
        () => written.forEach((savedAt) => mine.delete(savedAt)),
      );
    },
    disable() {
      disabled = true;
      dirty = false;
      clear();
    },
    dispose() {
      disposed = true;
      clear();
    },
    settled: () => last,
  };
}
