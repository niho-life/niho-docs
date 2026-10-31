import "server-only";
import {
  audioInfo,
  completeAudioUpload,
  completeImageUpload,
  countPageImages,
  createRecordingPage,
  duplicatePage,
  enableShare,
  getRecording,
  getShare,
  imageAsset,
  rotateShare,
  searchPages,
  sharedImageAsset,
  startAudioRecording,
  startImageUpload,
  stopShare,
  updateImageMeta,
  updateRecording,
} from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { getStorage } from "../storage/runtime";
import type { AudioApiDeps } from "./audio-api";
import { getPool, getStore } from "./db";
import type { ImageApiDeps } from "./images-api";
import type { PagesApiDeps } from "./pages-api";
import type { RecordingsApiDeps } from "./recordings-api";
import type { SearchApiDeps } from "./search-api";
import type { ShareApiDeps } from "./share-api";

/** 実行時の依存（方式の選択・DB の接続は要求のたびに遅延して決める）。`/auth/*` の route も同じものを使う。 */
export const runtimeDeps: PagesApiDeps = {
  auth: () => getAuthProvider(),
  store: () => getStore(),
};

/** `/api/search` の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const searchDeps: SearchApiDeps = {
  auth: () => getAuthProvider(),
  search: () => {
    const pool = getPool();
    return pool ? (owner, query, options) => searchPages(pool, owner, query, options) : null;
  },
};

/** 共有・複製・書き出し（#34）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const shareDeps: ShareApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const store = getStore();
    const pool = getPool();
    if (!store || !pool) return null;
    return {
      getShare: (owner, pageId) => getShare(pool, owner, pageId),
      enableShare: (owner, pageId) => enableShare(pool, owner, pageId),
      rotateShare: (owner, pageId) => rotateShare(pool, owner, pageId),
      stopShare: (owner, pageId) => stopShare(pool, owner, pageId),
      duplicatePage: (owner, pageId) => duplicatePage(pool, owner, pageId),
      // 書き出しは本人の・ゴミ箱でないページの最新の保存版（EditorStore.getPage と同じ絞り込み）
      getPage: (owner, pageId) => store.getPage(owner, pageId),
    };
  },
};

/** 録音と文字起こし（#36）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const recordingDeps: RecordingsApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      createRecordingPage: (owner, input) => createRecordingPage(pool, owner, input),
      getRecording: (owner, pageId) => getRecording(pool, owner, pageId),
      updateRecording: (owner, pageId, baseRevision, mutate) => updateRecording(pool, owner, pageId, baseRevision, mutate),
    };
  },
};

/** 録音の音声のアップロード（#36 段 2a）の実行時の依存（DB・保存先は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const audioDeps: AudioApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      startAudioRecording: (owner, input) => startAudioRecording(pool, owner, input),
      completeAudioUpload: (owner, pageId, stored) => completeAudioUpload(pool, owner, pageId, stored),
      audioInfo: (owner, pageId) => audioInfo(pool, owner, pageId),
      getRecording: (owner, pageId) => getRecording(pool, owner, pageId),
    };
  },
  storage: () => getStorage(process.env),
};

/** 本文の画像（#33）の実行時の依存（DB・保存先は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const imageDeps: ImageApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      startImageUpload: (owner, input) => startImageUpload(pool, owner, input),
      completeImageUpload: (owner, assetId, stored) => completeImageUpload(pool, owner, assetId, stored),
      imageAsset: (owner, assetId) => imageAsset(pool, owner, assetId),
      updateImageMeta: (owner, assetId, patch) => updateImageMeta(pool, owner, assetId, patch),
      countPageImages: (owner, pageId) => countPageImages(pool, owner, pageId),
      sharedImageAsset: (token, assetId) => sharedImageAsset(pool, token, assetId),
    };
  },
  storage: () => getStorage(process.env),
};
