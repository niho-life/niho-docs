/**
 * 録音の控え（IndexedDB）。マイクで録っている間、塊（MediaRecorder の dataavailable）が来るたびに端末へ書いておき、
 * **録音中に画面を閉じても録ったものを失わない**ようにする（#36 段 3b-1 の「守ること」）。
 * 正本はサーバーで、ここはアップロードが済むまで一時的に持っているだけ（下書き drafts.ts と同じ考え方）。
 *
 * - 消す時: 取り込めた（サーバーに入った）・自分で「消す」を押した・7 日より古い（開いたときに掃除する）。
 *   画面を離れただけでは消さない（次に開いたときに「前回の録音が残っています」と出して取り込める）。
 * - 下書き（drafts.ts）とは別の DB にする。同じ DB を別の版で開くと、先に版を上げた側が勝って他方が開けなくなるため
 *   （ここを足すために下書きの版を上げない）。
 * - IndexedDB が使えない・容量を超えた・例外のときは、画面を壊さず「控えなし」として録音を続ける（戻り値は null・reject）。
 * - 中身（音声）は ArrayBuffer で持つ（Blob を構造化複製できないブラウザ・テストでも読み書きできる）。
 */

export const KEEP_DB_NAME = "niho-editor-recordings";
export const KEEP_DB_VERSION = 1;
/** 録音 1 回ぶんの見出し（key は take の id）。 */
export const KEEP_TAKES_STORE = "takes";
/** 音声の塊（key は `{take id}#{8 桁の順番}`。範囲で引ける）。 */
export const KEEP_CHUNKS_STORE = "chunks";
/** 控えを残す日数（これより古いものは、開いたときに消す）。 */
export const KEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 控えてある録音 1 回ぶん。 */
export type KeptTake = {
  id: string;
  /** 取り込むときのファイル名（`録音 YYYY-MM-DD HH-mm.webm`）。 */
  name: string;
  mimeType: string;
  /** 録り始めた時刻（ISO 8601）。掃除と並び順に使う。 */
  startedAt: string;
  /** ここまでの長さ（秒）。止める前に閉じた控えは、最後に書いた塊までの長さ。 */
  durationSec: number;
  /** ここまでの大きさ（バイト）。 */
  bytes: number;
  /** 止め終わった（長さが確かな）控えか。 */
  finished: boolean;
};

export type RecordingKeep = {
  /** 録音を始めた（控えの枠を作る）。 */
  begin: (take: Pick<KeptTake, "id" | "name" | "mimeType" | "startedAt">) => Promise<void>;
  /** 塊 1 つを足す（順番は 1 から。ここまでの長さも更新する）。 */
  addChunk: (id: string, seq: number, bytes: ArrayBuffer, durationSec: number) => Promise<void>;
  /** 止めた（長さが決まった）。 */
  finish: (id: string, durationSec: number) => Promise<void>;
  /** 残っている控え（新しい順）。7 日より古いものは消してから返す。 */
  list: () => Promise<KeptTake[]>;
  /** 控えを 1 つの File にする（塊を順に繋ぐ）。無ければ null。 */
  load: (id: string) => Promise<{ take: KeptTake; file: File } | null>;
  /** 控えを消す（塊も）。 */
  remove: (id: string) => Promise<void>;
};

const SEQ_DIGITS = 8;

/** 塊の key（順番で並ぶように 0 を詰める）。 */
export function chunkKey(id: string, seq: number): string {
  return `${id}#${String(seq).padStart(SEQ_DIGITS, "0")}`;
}

function isKeptTake(value: unknown): value is KeptTake {
  if (typeof value !== "object" || value === null) return false;
  const take = value as Record<string, unknown>;
  return (
    typeof take.id === "string" &&
    take.id.length > 0 &&
    typeof take.name === "string" &&
    take.name.length > 0 &&
    typeof take.mimeType === "string" &&
    typeof take.startedAt === "string" &&
    typeof take.durationSec === "number" &&
    Number.isFinite(take.durationSec) &&
    typeof take.bytes === "number" &&
    Number.isFinite(take.bytes) &&
    typeof take.finished === "boolean"
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

/** 素の IndexedDB の控え。IndexedDB が無ければ null（控えなし）。 */
export function createIndexedDbRecordingKeep(
  factory: IDBFactory | undefined = browserIndexedDb(),
  options: { now?: () => number } = {},
): RecordingKeep | null {
  if (!factory) return null;
  const now = options.now ?? (() => Date.now());
  let opening: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(KEEP_DB_NAME, KEEP_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(KEEP_TAKES_STORE)) db.createObjectStore(KEEP_TAKES_STORE);
        if (!db.objectStoreNames.contains(KEEP_CHUNKS_STORE)) db.createObjectStore(KEEP_CHUNKS_STORE);
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

  /** 1 つの transaction（作った順に適用される）。戻り値は operate が返した request の結果。 */
  const run = <T>(stores: string[], mode: IDBTransactionMode, operate: (transaction: IDBTransaction) => IDBRequest<T> | null): Promise<T | null> =>
    open().then(
      (db) =>
        new Promise<T | null>((resolve, reject) => {
          const transaction = db.transaction(stores, mode);
          const request = operate(transaction);
          transaction.oncomplete = () => resolve(request ? request.result : null);
          transaction.onabort = () => reject(transaction.error ?? request?.error ?? new Error("indexedDB transaction aborted"));
        }),
    );

  const chunkRange = (id: string) => IDBKeyRange.bound(`${id}#`, `${id}#￿`);

  /** 見出しを読んで書き換える（1 つの transaction の中で）。 */
  const patch = (transaction: IDBTransaction, id: string, change: (take: KeptTake) => KeptTake): IDBRequest<unknown> => {
    const takes = transaction.objectStore(KEEP_TAKES_STORE);
    const read = takes.get(id);
    read.onsuccess = () => {
      const stored: unknown = read.result;
      // 消したあとに遅れて届いた塊で、控えを作り直さない
      if (isKeptTake(stored)) takes.put(change(stored), id);
    };
    return read;
  };

  const remove = async (id: string): Promise<void> => {
    await run([KEEP_TAKES_STORE, KEEP_CHUNKS_STORE], "readwrite", (transaction) => {
      transaction.objectStore(KEEP_CHUNKS_STORE).delete(chunkRange(id));
      return transaction.objectStore(KEEP_TAKES_STORE).delete(id);
    });
  };

  return {
    remove,
    async begin(take) {
      const started: KeptTake = { ...take, durationSec: 0, bytes: 0, finished: false };
      await run([KEEP_TAKES_STORE], "readwrite", (transaction) => transaction.objectStore(KEEP_TAKES_STORE).put(started, take.id));
    },
    async addChunk(id, seq, bytes, durationSec) {
      await run([KEEP_TAKES_STORE, KEEP_CHUNKS_STORE], "readwrite", (transaction) =>
        // 塊は、見出しがあると確かめた同じ transaction の中で書く。消したあとに遅れて届いた塊を先に書くと、
        // 一覧にも 7 日の掃除にも出ない塊が残って、端末の容量を使い続ける
        patch(transaction, id, (take) => {
          transaction.objectStore(KEEP_CHUNKS_STORE).put(bytes, chunkKey(id, seq));
          return {
            ...take,
            durationSec: Math.max(take.durationSec, durationSec),
            bytes: take.bytes + bytes.byteLength,
          };
        }),
      );
    },
    async finish(id, durationSec) {
      await run([KEEP_TAKES_STORE], "readwrite", (transaction) => patch(transaction, id, (take) => ({ ...take, durationSec, finished: true })));
    },
    async list() {
      const values = (await run<unknown[]>([KEEP_TAKES_STORE], "readonly", (transaction) => transaction.objectStore(KEEP_TAKES_STORE).getAll())) ?? [];
      const takes = values.filter(isKeptTake);
      const limit = now() - KEEP_MAX_AGE_MS;
      const old = takes.filter((take) => {
        const at = Date.parse(take.startedAt);
        return Number.isFinite(at) && at < limit;
      });
      // 古い控えは消してから返す（端末を埋めない）
      for (const take of old) await remove(take.id).catch(() => undefined);
      const kept = new Set(old.map((take) => take.id));
      return takes.filter((take) => !kept.has(take.id)).sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    },
    async load(id) {
      const take = await run<unknown>([KEEP_TAKES_STORE], "readonly", (transaction) => transaction.objectStore(KEEP_TAKES_STORE).get(id));
      if (!isKeptTake(take)) return null;
      const parts = (await run<unknown[]>([KEEP_CHUNKS_STORE], "readonly", (transaction) => transaction.objectStore(KEEP_CHUNKS_STORE).getAll(chunkRange(id)))) ?? [];
      const bytes = parts.filter((part): part is ArrayBuffer => part instanceof ArrayBuffer);
      if (bytes.length === 0) return null;
      return { take, file: new File(bytes, take.name, { type: take.mimeType }) };
    },
  };
}

let shared: RecordingKeep | null | undefined;

/** この画面で使う控え（1 つだけ作る）。IndexedDB が無ければ null。 */
export function recordingKeep(): RecordingKeep | null {
  shared ??= createIndexedDbRecordingKeep();
  return shared;
}

/** テスト用。次の recordingKeep() で作り直す。 */
export function resetRecordingKeep(): void {
  shared = undefined;
}
