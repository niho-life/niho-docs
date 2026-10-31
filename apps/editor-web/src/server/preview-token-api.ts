import { createHash, randomBytes } from "node:crypto";
import {
  API_ORIGIN,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PREVIEW_TOKEN_PREFIX,
  UUID_PATTERN,
  isConnectionHandle,
  isFaceDest,
} from "@niho/editor-publish-contract";
import { roleAllows, type Clock, type ConnectionSource, type RoleReader } from "@niho/editor-publish";
import type { OwnerId } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 本人がプレビュー token を発行する（#40）。`POST /api/pages/{id}/preview-token`、本文は `{ handle }`。
 * 201 `{ token, expiresAt, url }`（url は公開 API の `/v1/preview/{token}.json`）。token の平文はこの応答にだけ出し、保存はハッシュだけ。
 *
 * - 本人だけ（未認証 401）。更新系なので同じ origin の画面からだけ（違えば 403）。DB が無いと 503。
 * - ページは本人の・ゴミ箱でないもの。handle は、本人が役割で出せる面（`exp` / `niho`）か、本人の解除していない接続。
 *   どちらかが満たされなければ同じ 404（別の人のページ・接続の有無を推測させない）。handle の形が違えば 400。
 * - 有効期限は発行から 15 分（契約の上限）。token は page と handle にだけ拘束し、下書きの版には拘束しない（自動保存のあとも読める）。
 */

export interface PreviewTokenRecord {
  readonly pageId: string;
  /** 面は `exp` / `niho`、本人のサイトは接続の handle。 */
  readonly handle: string;
  /** token の SHA-256（小文字の hex）。平文は渡さない。 */
  readonly sha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PreviewTokenStore {
  /** 本人（owner）の・ゴミ箱でないページなら 1 行保存して true。そうでなければ何も書かずに false。 */
  issue(owner: OwnerId, record: PreviewTokenRecord): Promise<boolean>;
}

export type PreviewTokenApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => PreviewTokenStore | null;
  /** NIHO の役割（要求のたびに読む。保存しない）。 */
  roles: () => RoleReader;
  /** 本人の解除していない接続（DB が使えないときは null で 503）。 */
  connections: () => ConnectionSource | null;
  clock?: Clock;
  /** 乱数（既定は node:crypto の randomBytes）。 */
  random?: (size: number) => Uint8Array;
  env?: Readonly<Record<string, string | undefined>>;
};

export const PREVIEW_TOKEN_TTL_MS = PREVIEW_TOKEN_MAX_TTL_SECONDS * 1000;

/** 本文の上限（`{ handle }` だけ）。 */
const MAX_PREVIEW_TOKEN_BODY_BYTES = 4096;

const systemClock: Clock = { now: () => new Date().toISOString() };

/** `{ handle }`（他の field は不可）。handle は面か、接続に使える形。 */
function parseHandle(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.handle !== "string") return null;
  return isFaceDest(record.handle) || isConnectionHandle(record.handle) ? record.handle : null;
}

/** POST /api/pages/{id}/preview-token */
export function issuePreviewTokenRoute(request: Request, id: string, deps: PreviewTokenApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/preview-token", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const connections = deps.connections();
    if (!store || !connections) return errorResponse("unavailable");
    const body = await readJsonBody(request, MAX_PREVIEW_TOKEN_BODY_BYTES);
    if (!body.ok) return body.response;
    const handle = parseHandle(body.value);
    if (handle === null) return errorResponse("bad_request");
    if (!UUID_PATTERN.test(id)) return notFoundResponse();
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const allowed = isFaceDest(handle)
      ? roleAllows(await deps.roles().read(session.userId), handle)
      : await connections.has(session.userId, handle);
    if (!allowed) return notFoundResponse();
    // 256 bit の乱数（base64url の 43 文字。契約の `pv_` の形）
    const token = `${PREVIEW_TOKEN_PREFIX}${Buffer.from((deps.random ?? randomBytes)(32)).toString("base64url")}`;
    const issuedAt = new Date((deps.clock ?? systemClock).now()).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + PREVIEW_TOKEN_TTL_MS).toISOString();
    const sha256 = createHash("sha256").update(token, "utf8").digest("hex");
    if (!(await store.issue(session.userId, { pageId: id, handle, sha256, issuedAt, expiresAt }))) return notFoundResponse();
    return jsonResponse(201, { token, expiresAt, url: `${API_ORIGIN}/v1/preview/${token}.json` });
  });
}
