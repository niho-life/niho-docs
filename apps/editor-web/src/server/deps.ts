import "server-only";
import { connectionSource } from "@niho/editor-publish";
import {
  createRecordingPage,
  duplicatePage,
  enableShare,
  getRecording,
  getShare,
  rotateShare,
  searchPages,
  stopShare,
  updateRecording,
} from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { publishConfig } from "../publish/config";
import { pgDraftFingerprints, pgPublishStore } from "../publish/pg-store";
import { assetUrlsOf, faceDeclarations, roleReaderOf, sessionAuthors, wirePublishPorts } from "../publish/ports";
import { getPool, getStore } from "./db";
import { faceCredentialsFromEnv } from "../public-api/source";
import type { PublicApiRouteDeps } from "../public-api/http";
import { pgPreviewTokenStore, pgPublicApiSource } from "../public-api/pg-source";
import { createFixedWindowLimiter, rateLimitFromEnv, type RateLimiter } from "../public-api/rate-limit";
import type { PagesApiDeps } from "./pages-api";
import type { PreviewTokenApiDeps } from "./preview-token-api";
import type { PublishApiDeps } from "./publish-api";
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

/**
 * 公開 API v1（`/v1/*`。#40）の実行時の依存。データは Postgres（src/public-api/pg-source.ts。Pool は getStore と共有、DATABASE_URL が
 * 無ければ 503 temporarily_unavailable）。面の資格は `EDITOR_FACE_CREDENTIALS`（要求のたびに読み、値が変わらなければ読み直さない）。
 * rate limit は instance に 1 つ（`EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE`。最初の要求のときに読む）。
 * プレビューの写真の URL と面の宣言は公開のシート（#39）と同じ配線（`EDITOR_ASSET_ORIGIN`・`EDITOR_DESTINATION_DECLARATIONS`。
 * src/publish/config.ts）。著者は発行のときに token に結んだもの（previewTokenDeps）。
 */
let publicApiLimiter: RateLimiter | null = null;
export const publicApiDeps: PublicApiRouteDeps = {
  source: () => {
    const pool = getPool();
    if (!pool) return null;
    const config = publishConfig(process.env);
    return pgPublicApiSource(pool, { assetUrls: assetUrlsOf(config.assetOrigin), declarations: faceDeclarations(config.declarations) });
  },
  faces: () => faceCredentialsFromEnv(process.env),
  limiter: () => (publicApiLimiter ??= createFixedWindowLimiter(rateLimitFromEnv(process.env))),
};

/**
 * プレビュー token の発行（`POST /api/pages/{id}/preview-token`。#40）の実行時の依存。保存先と接続は Postgres（DB が無ければ 503）。
 * NIHO の役割と著者は公開のシート（#39）と同じ（stub は `EDITOR_STUB_ROLES`、niho は役割の契約まで無し。著者は session の名前）。
 */
export const previewTokenDeps: PreviewTokenApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    return pool ? pgPreviewTokenStore(pool) : null;
  },
  roles: (session) => roleReaderOf(publishConfig(process.env), session),
  authors: (session) => sessionAuthors(session),
  connections: () => {
    const pool = getPool();
    return pool ? connectionSource(pgPublishStore(pool)) : null;
  },
};

/** 公開のシート（#39）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const publishDeps: PublishApiDeps = {
  auth: () => getAuthProvider(),
  ports: (session) => {
    const pool = getPool();
    return pool ? wirePublishPorts(pgPublishStore(pool), session, { drafts: pgDraftFingerprints(pool) }) : null;
  },
};
