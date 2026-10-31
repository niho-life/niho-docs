import "server-only";
import { resolveStorageConfig, type StorageEnv } from "./config";
import { createFakeStorage, createFakeStorageState, type FakeStorage, type FakeStorageState } from "./fake";
import { createGcsStorage } from "./gcs";
import type { ObjectStorage } from "./types";

type Holder = {
  __nihoEditorFakeStorage?: { state: FakeStorageState; storage: FakeStorage };
  __nihoEditorGcsStorage?: { bucket: string; storage: ObjectStorage };
};

// dev の再読み込み・route ごとの bundle で別々にならないよう、process に 1 つだけ持つ（db.ts の Pool と同じ）。
// 偽物の中身（セッションと object）は、開始の route と dev の受け口の route で同じものを見る必要がある。
const holder = globalThis as typeof globalThis & Holder;

/** 偽の保存先（process に 1 つ）。 */
export function getFakeStorage(): FakeStorage {
  if (!holder.__nihoEditorFakeStorage) {
    const state = createFakeStorageState();
    holder.__nihoEditorFakeStorage = { state, storage: createFakeStorage({ state }) };
  }
  return holder.__nihoEditorFakeStorage.storage;
}

/**
 * 要求ごとの保存先（`EDITOR_STORAGE` を毎回読む）。使えないとき（`off`・設定の誤り・本番の fake）は null（呼び出し側で 503）。
 * 設定の誤りは起動時の検査（src/startup-check.ts）が先に止めるので、ここは後ろの守り（値を出さずに null）。
 */
export function getStorage(env: StorageEnv = process.env): ObjectStorage | null {
  let config;
  try {
    config = resolveStorageConfig(env);
  } catch {
    return null;
  }
  if (config.kind === "off") return null;
  if (config.kind === "fake") return getFakeStorage();
  if (holder.__nihoEditorGcsStorage?.bucket !== config.bucket) {
    // token はこの storage の中にだけ持つ（期限まで）
    holder.__nihoEditorGcsStorage = { bucket: config.bucket, storage: createGcsStorage({ bucket: config.bucket }) };
  }
  return holder.__nihoEditorGcsStorage.storage;
}
