import "server-only";
import {
  audioInfo,
  completeAudioUpload,
  createRecordingPage,
  duplicatePage,
  enableShare,
  enqueueTranscription,
  failRun,
  getRecording,
  getShare,
  latestRun,
  rotateShare,
  searchPages,
  startAudioRecording,
  stopShare,
  transcriptionStatus,
  updateRecording,
} from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { getStorage } from "../storage/runtime";
import { getTranscriptionRunner } from "../transcription/runtime";
import type { AudioApiDeps } from "./audio-api";
import { getPool, getStore } from "./db";
import type { PagesApiDeps } from "./pages-api";
import type { RecordingsApiDeps } from "./recordings-api";
import type { SearchApiDeps } from "./search-api";
import type { ShareApiDeps } from "./share-api";
import type { TranscriptionApiDeps } from "./transcription-api";

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
      latestTranscription: (owner, pageId) => latestRun(pool, owner, pageId),
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

/**
 * 録音の文字起こし（#36 段 2b）の実行時の依存（DB・エンジン・実行の呼び出し口は要求のたびに遅延して決める。Pool は getStore と共有）。
 * 本番は実行の口（Cloud Tasks と worker）ができるまで runner が null（開始は 503 transcription_unavailable）。
 */
export const transcriptionDeps: TranscriptionApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      enqueue: (owner, pageId, input) => enqueueTranscription(pool, owner, pageId, input),
      status: (owner, pageId) => transcriptionStatus(pool, owner, pageId),
      failRun: (runId, generation, errorCode) => failRun(pool, runId, generation, errorCode),
    };
  },
  runner: () => {
    const pool = getPool();
    return pool ? getTranscriptionRunner(pool, process.env) : null;
  },
};
