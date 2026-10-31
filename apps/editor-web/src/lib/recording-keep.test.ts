import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_CHUNKS_STORE, KEEP_DB_NAME, KEEP_MAX_AGE_MS, chunkKey, createIndexedDbRecordingKeep, type RecordingKeep } from "./recording-keep";

// 合成の音声（中身は数バイト）だけを使う

const TAKE = { id: "11111111-1111-4111-8111-111111111111", name: "録音 2026-11-01 09-30.webm", mimeType: "audio/webm", startedAt: "2026-11-01T00:30:00.000Z" };
const OTHER = { ...TAKE, id: "22222222-2222-4222-8222-222222222222", name: "録音 2026-11-01 10-00.webm", startedAt: "2026-11-01T01:00:00.000Z" };

const NOW = Date.parse("2026-11-01T02:00:00.000Z");
const bytes = (...values: number[]) => new Uint8Array(values).buffer;

beforeEach(() => {
  // IndexedDB の範囲（塊の key の範囲）は、テストでは fake-indexeddb のものを使う
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 同じ端末（同じ IndexedDB）を、画面を開き直したものとして作り直す。 */
function keepOn(factory: IDBFactory, now: number = NOW): RecordingKeep {
  return createIndexedDbRecordingKeep(factory, { now: () => now })!;
}

/** chunks の表に残っている行の数。一覧と読み出しは見出しから引くので、見出しの無い塊はそこでは見えない。 */
function countChunks(factory: IDBFactory): Promise<number> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(KEEP_DB_NAME);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const counting = db.transaction(KEEP_CHUNKS_STORE, "readonly").objectStore(KEEP_CHUNKS_STORE).count();
      counting.onerror = () => reject(counting.error);
      counting.onsuccess = () => {
        db.close();
        resolve(counting.result);
      };
    };
  });
}

describe("createIndexedDbRecordingKeep（録音の控え）", () => {
  it("録音中に画面を閉じても、ここまでの塊が残っていて 1 つのファイルとして読み出せる", async () => {
    const factory = new IDBFactory();
    const recording = keepOn(factory);
    await recording.begin(TAKE);
    await recording.addChunk(TAKE.id, 1, bytes(1, 2, 3), 1);
    await recording.addChunk(TAKE.id, 2, bytes(4, 5), 2);
    // ここで画面が閉じた（finish を呼べていない）

    // 開き直した画面
    const reopened = keepOn(factory);
    const takes = await reopened.list();
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ id: TAKE.id, name: TAKE.name, bytes: 5, durationSec: 2, finished: false });

    const loaded = await reopened.load(TAKE.id);
    expect(loaded?.take.id).toBe(TAKE.id);
    expect(loaded?.file.name).toBe(TAKE.name);
    expect(loaded?.file.type).toBe("audio/webm");
    // 塊は順番どおりに繋がる
    expect([...new Uint8Array(await loaded!.file.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it("止めた録音は長さが確かな控えになる", async () => {
    const factory = new IDBFactory();
    const recording = keepOn(factory);
    await recording.begin(TAKE);
    await recording.addChunk(TAKE.id, 1, bytes(1), 1);
    await recording.finish(TAKE.id, 1.5);
    expect((await keepOn(factory).list())[0]).toMatchObject({ durationSec: 1.5, finished: true });
  });

  it("消したら、見出しも塊も残らない", async () => {
    const factory = new IDBFactory();
    const recording = keepOn(factory);
    await recording.begin(TAKE);
    await recording.addChunk(TAKE.id, 1, bytes(1), 1);
    await recording.remove(TAKE.id);
    expect(await recording.list()).toEqual([]);
    expect(await recording.load(TAKE.id)).toBeNull();
    expect(await countChunks(factory)).toBe(0);
    // 消したあとに遅れて届いた塊で、控えを作り直さない。塊も書かない（一覧からも掃除からも見えない塊が残るため）
    await recording.addChunk(TAKE.id, 2, bytes(2), 2);
    expect(await recording.list()).toEqual([]);
    expect(await countChunks(factory)).toBe(0);
  });

  it("新しい順に返し、7 日より古い控えは開いたときに消す", async () => {
    const factory = new IDBFactory();
    const recording = keepOn(factory);
    await recording.begin(TAKE);
    await recording.addChunk(TAKE.id, 1, bytes(1), 1);
    await recording.begin(OTHER);
    await recording.addChunk(OTHER.id, 1, bytes(2), 1);
    expect((await recording.list()).map((take) => take.id)).toEqual([OTHER.id, TAKE.id]);

    const later = keepOn(factory, Date.parse(OTHER.startedAt) + KEEP_MAX_AGE_MS + 1);
    expect(await later.list()).toEqual([]);
    expect(await later.load(TAKE.id)).toBeNull();
  });

  it("塊の key は順番で並ぶ", () => {
    expect(chunkKey(TAKE.id, 2) < chunkKey(TAKE.id, 10)).toBe(true);
  });

  it("IndexedDB が無ければ控えなし（null）", () => {
    expect(createIndexedDbRecordingKeep(undefined)).toBeNull();
  });
});
