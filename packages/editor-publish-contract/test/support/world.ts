import {
  createReferenceServer,
  hashCredential,
  type ReferenceResponse,
  type ReferenceWorld,
  type WorldPage,
  type WorldPublication,
} from "../../test-support/reference-server.js";
import type { PublicationRange } from "../../src/v1.js";
import {
  createRng,
  draftContent,
  minutesFrom,
  snapshot,
  syntheticKey,
  syntheticPreviewToken,
  syntheticServiceToken,
  syntheticUuid,
} from "./synthetic.js";

export const NOW = "2026-10-01T00:00:00.000Z";
export const SITE_A = "site-alpha";
export const SITE_B = "site-beta";
export const SITE_C = "site-gamma";
export const MOVED_FACE_URL = "https://niho.example.com/article/moved-between-faces";

export interface Credentials {
  readonly siteA: string;
  readonly siteARotated: string;
  readonly siteARevoked: string;
  readonly siteB: string;
  readonly siteCRemoved: string;
  readonly exp: string;
  readonly niho: string;
  readonly expExpired: string;
  readonly nihoRevoked: string;
  readonly unknownKey: string;
  readonly previewExp: string;
  readonly previewSiteA: string;
  readonly previewExpired: string;
  readonly previewLongLived: string;
  readonly previewUnknown: string;
}

export interface PageIds {
  readonly siteLive: string;
  readonly siteLiveOlder: string;
  readonly draft: string;
  readonly private: string;
  readonly stopped: string;
  readonly expLive: string;
  readonly expUnlisted: string;
  readonly nihoLive: string;
  readonly siteBLive: string;
  readonly faceStopped: string;
  readonly movedFaceToFace: string;
  readonly movedFaceToSite: string;
  readonly movedSiteToFace: string;
  readonly movedTargetStopped: string;
  readonly missing: string;
}

export interface Fixture {
  readonly world: ReferenceWorld;
  readonly keys: Credentials;
  readonly ids: PageIds;
}

function page(id: string, ownerId: string, slug: string): WorldPage {
  return { id, ownerId, draft: { revision: 1, savedAt: "2026-09-30T12:00:00.000Z", content: draftContent(slug) } };
}

export function publication(
  pageId: string,
  handle: string,
  slug: string,
  updatedAt: string,
  options: { range?: PublicationRange; stoppedAt?: string; movedToHandle?: string; canonicalUrl?: string } = {},
): WorldPublication {
  const dest = handle === "exp" || handle === "niho" ? handle : "site";
  return {
    pageId,
    handle,
    range: options.range ?? "live",
    stoppedAt: options.stoppedAt ?? null,
    movedToHandle: options.movedToHandle ?? null,
    snapshot: snapshot({
      id: pageId,
      dest,
      slug,
      title: `Published ${slug}`,
      updatedAt,
      publishedAt: "2026-09-01T00:00:00.000Z",
      ...(options.canonicalUrl ? { canonicalUrl: options.canonicalUrl } : {}),
    }),
  };
}

/** One synthetic world that every server scenario mutates. */
export async function buildFixture(): Promise<Fixture> {
  const rng = createRng(40);
  const keys: Credentials = {
    siteA: syntheticKey(rng),
    siteARotated: syntheticKey(rng),
    siteARevoked: syntheticKey(rng),
    siteB: syntheticKey(rng),
    siteCRemoved: syntheticKey(rng),
    exp: syntheticServiceToken(rng),
    niho: syntheticServiceToken(rng),
    expExpired: syntheticServiceToken(rng),
    nihoRevoked: syntheticServiceToken(rng),
    unknownKey: syntheticKey(rng),
    previewExp: syntheticPreviewToken(rng),
    previewSiteA: syntheticPreviewToken(rng),
    previewExpired: syntheticPreviewToken(rng),
    previewLongLived: syntheticPreviewToken(rng),
    previewUnknown: syntheticPreviewToken(rng),
  };
  const ids: PageIds = {
    siteLive: syntheticUuid(rng),
    siteLiveOlder: syntheticUuid(rng),
    draft: syntheticUuid(rng),
    private: syntheticUuid(rng),
    stopped: syntheticUuid(rng),
    expLive: syntheticUuid(rng),
    expUnlisted: syntheticUuid(rng),
    nihoLive: syntheticUuid(rng),
    siteBLive: syntheticUuid(rng),
    faceStopped: syntheticUuid(rng),
    movedFaceToFace: syntheticUuid(rng),
    movedFaceToSite: syntheticUuid(rng),
    movedSiteToFace: syntheticUuid(rng),
    movedTargetStopped: syntheticUuid(rng),
    missing: syntheticUuid(rng),
  };
  const hash = hashCredential;
  const owner = "owner-a";
  const world: ReferenceWorld = {
    now: NOW,
    pages: [
      page(ids.siteLive, owner, "site-live"),
      page(ids.siteLiveOlder, owner, "site-live-older"),
      page(ids.draft, owner, "draft-page"),
      page(ids.private, owner, "private-page"),
      page(ids.stopped, owner, "stopped-page"),
      page(ids.expLive, "writer-x", "exp-live"),
      page(ids.expUnlisted, "writer-x", "exp-unlisted"),
      page(ids.nihoLive, "resident-y", "niho-live"),
      page(ids.siteBLive, "owner-b", "site-b-live"),
      page(ids.faceStopped, "writer-x", "face-stopped"),
      page(ids.movedFaceToFace, "writer-x", "moved-between-faces"),
      page(ids.movedFaceToSite, owner, "moved-face-to-site"),
      page(ids.movedSiteToFace, owner, "moved-site-to-face"),
      page(ids.movedTargetStopped, "writer-x", "moved-target-stopped"),
    ],
    publications: [
      publication(ids.siteLive, SITE_A, "site-live", "2026-09-20T00:00:00.000Z"),
      publication(ids.siteLiveOlder, SITE_A, "site-live-older", "2026-09-10T00:00:00.000Z"),
      publication(ids.stopped, SITE_A, "stopped-page", "2026-09-05T00:00:00.000Z", { stoppedAt: "2026-09-25T00:00:00.000Z" }),
      publication(ids.expLive, "exp", "exp-live", "2026-09-21T00:00:00.000Z"),
      publication(ids.expUnlisted, "exp", "exp-unlisted", "2026-09-22T00:00:00.000Z", { range: "unlisted" }),
      publication(ids.nihoLive, "niho", "niho-live", "2026-09-23T00:00:00.000Z"),
      publication(ids.siteBLive, SITE_B, "site-b-live", "2026-09-24T00:00:00.000Z"),
      publication(ids.faceStopped, "exp", "face-stopped", "2026-09-02T00:00:00.000Z", { stoppedAt: "2026-09-26T00:00:00.000Z" }),
      publication(ids.movedFaceToFace, "exp", "moved-between-faces", "2026-09-03T00:00:00.000Z", {
        stoppedAt: "2026-09-26T00:00:00.000Z",
        movedToHandle: "niho",
      }),
      publication(ids.movedFaceToFace, "niho", "moved-between-faces", "2026-09-26T00:00:00.000Z", { canonicalUrl: MOVED_FACE_URL }),
      publication(ids.movedFaceToSite, "exp", "moved-face-to-site", "2026-09-03T00:00:00.000Z", {
        stoppedAt: "2026-09-26T00:00:00.000Z",
        movedToHandle: SITE_A,
      }),
      publication(ids.movedFaceToSite, SITE_A, "moved-face-to-site", "2026-09-26T00:00:00.000Z"),
      publication(ids.movedSiteToFace, SITE_A, "moved-site-to-face", "2026-09-03T00:00:00.000Z", {
        stoppedAt: "2026-09-26T00:00:00.000Z",
        movedToHandle: "exp",
      }),
      publication(ids.movedSiteToFace, "exp", "moved-site-to-face", "2026-09-26T00:00:00.000Z"),
      publication(ids.movedTargetStopped, "exp", "moved-target-stopped", "2026-09-03T00:00:00.000Z", {
        stoppedAt: "2026-09-26T00:00:00.000Z",
        movedToHandle: "niho",
      }),
      publication(ids.movedTargetStopped, "niho", "moved-target-stopped", "2026-09-26T00:00:00.000Z", {
        stoppedAt: "2026-09-28T00:00:00.000Z",
      }),
    ],
    connections: [
      {
        id: "connection-alpha",
        handle: SITE_A,
        ownerId: owner,
        removedAt: null,
        keys: [
          { sha256: await hash(keys.siteA), revokedAt: null },
          { sha256: await hash(keys.siteARotated), revokedAt: "2026-09-20T00:00:00.000Z" },
          { sha256: await hash(keys.siteARevoked), revokedAt: "2026-09-30T00:00:00.000Z" },
        ],
      },
      { id: "connection-beta", handle: SITE_B, ownerId: "owner-b", removedAt: null, keys: [{ sha256: await hash(keys.siteB), revokedAt: null }] },
      {
        id: "connection-gamma",
        handle: SITE_C,
        ownerId: "owner-c",
        removedAt: "2026-09-28T00:00:00.000Z",
        keys: [{ sha256: await hash(keys.siteCRemoved), revokedAt: null }],
      },
    ],
    faceCredentials: [
      { sha256: await hash(keys.exp), audience: "exp", expiresAt: minutesFrom(NOW, 60), revokedAt: null },
      { sha256: await hash(keys.niho), audience: "niho", expiresAt: minutesFrom(NOW, 60), revokedAt: null },
      { sha256: await hash(keys.expExpired), audience: "exp", expiresAt: minutesFrom(NOW, -1), revokedAt: null },
      { sha256: await hash(keys.nihoRevoked), audience: "niho", expiresAt: minutesFrom(NOW, 60), revokedAt: minutesFrom(NOW, -1) },
    ],
    previewTokens: [
      { sha256: await hash(keys.previewExp), pageId: ids.draft, handle: "exp", issuedAt: minutesFrom(NOW, -5), expiresAt: minutesFrom(NOW, 10) },
      { sha256: await hash(keys.previewSiteA), pageId: ids.draft, handle: SITE_A, issuedAt: minutesFrom(NOW, -5), expiresAt: minutesFrom(NOW, 10) },
      { sha256: await hash(keys.previewExpired), pageId: ids.draft, handle: "exp", issuedAt: minutesFrom(NOW, -20), expiresAt: minutesFrom(NOW, -5) },
      { sha256: await hash(keys.previewLongLived), pageId: ids.draft, handle: "exp", issuedAt: minutesFrom(NOW, -1), expiresAt: minutesFrom(NOW, 30) },
    ],
  };
  return { world, keys, ids };
}

export interface CallOptions {
  readonly credential?: string;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly method?: string;
  readonly requestId?: string;
}

export function call(world: ReferenceWorld, url: string, options: CallOptions = {}): Promise<ReferenceResponse> {
  return createReferenceServer(world).handle({
    method: options.method ?? "GET",
    url,
    headers: { ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}), ...options.headers },
    requestId: options.requestId ?? "req_scenario",
  });
}

export const listPath = (handle: string, query = ""): string => `/v1/${handle}/published.json${query}`;
export const docPath = (handle: string, id: string): string => `/v1/${handle}/published/${id}.json`;
export const previewPath = (token: string): string => `/v1/preview/${token}.json`;

export function json(response: ReferenceResponse): Record<string, unknown> {
  if (response.body === null) throw new Error("response has no body");
  return JSON.parse(response.body) as Record<string, unknown>;
}
