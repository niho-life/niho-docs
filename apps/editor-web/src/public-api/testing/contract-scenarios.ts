/**
 * テスト専用：契約の server のシナリオ（packages/editor-publish-contract/test/support/world.ts・server-scenarios.ts の写し。
 * 契約の test/support は export されていない）。写し元との違いは、要求を受ける server を `call` で差し替えられることだけ。
 * cases.json の server の id と、ここの id が同じであることは handler.test.ts が確かめる（契約にシナリオが増えたら写す）。
 */

import { canonicalJson, renderMarkdown, type PublicationRange, type PublishedAsset } from "@niho/editor-publish-contract";
import {
  hashCredential,
  type ReferenceRequest,
  type ReferenceResponse,
  type ReferenceWorld,
  type WorldPage,
  type WorldPublication,
} from "@niho/editor-publish-contract/test-support";
import {
  createRng,
  draftContent,
  minutesFrom,
  paragraphs,
  snapshot,
  syntheticKey,
  syntheticPreviewToken,
  syntheticServiceToken,
  syntheticUuid,
} from "./synthetic";

// --- world（world.ts の写し） ------------------------------------------------------------------

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

/** world と要求を受けて答える server（参照モデルか、production の handler）。 */
export type WorldServer = (world: ReferenceWorld, request: ReferenceRequest) => Promise<ReferenceResponse>;
export type Call = (world: ReferenceWorld, url: string, options?: CallOptions) => Promise<ReferenceResponse>;

export function caller(server: WorldServer): Call {
  return (world, url, options = {}) => server(world, {
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

// --- scenarios（server-scenarios.ts の写し） ---------------------------------------------------

export type Outcome = Readonly<Record<string, unknown>>;
export type Scenario = (fixture: Fixture) => Promise<Outcome>;

function result(response: ReferenceResponse): Outcome {
  if (response.status < 400) return { status: response.status };
  const body = response.body === null ? undefined : (JSON.parse(response.body) as { error?: { code?: string }; movedTo?: unknown });
  const code = body?.error?.code;
  return response.status === 410 ? { status: response.status, code, movedTo: body?.movedTo ?? null } : { status: response.status, code };
}

function withPublications(world: ReferenceWorld, publications: readonly WorldPublication[]): ReferenceWorld {
  return { ...world, publications };
}

/** The draft of `pageId` is edited after publishing; nothing published may change. */
function editDraft(world: ReferenceWorld, pageId: string): ReferenceWorld {
  return {
    ...world,
    pages: world.pages.map((page) => page.id !== pageId ? page : {
      ...page,
      draft: {
        revision: page.draft.revision + 1,
        savedAt: "2026-09-30T23:59:00.000Z",
        content: { ...page.draft.content, title: "DRAFT-ONLY edited title", lead: "DRAFT-ONLY edited lead", blocks: paragraphs("DRAFT-ONLY edited body") },
      },
    }),
  };
}

function manyPublications(count: number, seed: number): WorldPublication[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, index) => publication(
    syntheticUuid(rng),
    SITE_A,
    `bulk-${index}`,
    // Repeating timestamps exercise the id tiebreak.
    new Date(Date.parse("2026-09-01T00:00:00.000Z") + (index % 4) * 3_600_000).toISOString(),
  ));
}

function expectedOrder(publications: readonly WorldPublication[]): string[] {
  return [...publications]
    .sort((a, b) => Date.parse(b.snapshot.updatedAt) - Date.parse(a.snapshot.updatedAt) || (a.pageId < b.pageId ? -1 : 1))
    .map((item) => item.pageId);
}

export function serverScenarios(call: Call): Readonly<Record<string, Scenario>> {
  async function listed(world: ReferenceWorld, url: string, credential: string, id: string): Promise<Outcome> {
    const response = await call(world, url, { credential });
    if (response.status !== 200) return result(response);
    const items = json(response).items as readonly { id: string }[];
    return { status: 200, listed: items.some((item) => item.id === id) };
  }

  async function etagOf(world: ReferenceWorld, url: string, credential: string): Promise<string> {
    const etag = (await call(world, url, { credential })).headers.etag;
    if (!etag) throw new Error("expected an ETag");
    return etag;
  }

  const get = async (world: ReferenceWorld, url: string, credential?: string, headers?: Record<string, string | readonly string[]>) =>
    result(await call(world, url, { ...(credential ? { credential } : {}), ...(headers ? { headers } : {}) }));

  return {
    // --- what is never listed or served -------------------------------------------
    "list-excludes-draft": ({ world, keys, ids }) => listed(world, listPath(SITE_A), keys.siteA, ids.draft),
    "get-draft-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.draft), keys.siteA),
    "list-excludes-private": ({ world, keys, ids }) => listed(world, listPath(SITE_A), keys.siteA, ids.private),
    "get-private-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.private), keys.siteA),
    "list-excludes-stopped": ({ world, keys, ids }) => listed(world, listPath(SITE_A), keys.siteA, ids.stopped),
    "get-stopped-gone": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.stopped), keys.siteA),
    "get-stopped-foreign-credential-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.stopped), keys.siteB),
    "get-missing-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.missing), keys.siteA),
    "get-other-dest-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.expLive), keys.siteA),
    "get-other-connection-page-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.siteBLive), keys.siteA),
    "get-foreign-handle-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_B, ids.siteBLive), keys.siteA),
    "list-foreign-handle-not-found": ({ world, keys }) => get(world, listPath(SITE_B), keys.siteA),
    "list-invalid-handle-not-found": ({ world, keys }) => get(world, listPath("Site_Alpha"), keys.siteA),
    "list-reserved-handle-not-found": ({ world, keys }) => get(world, listPath("admin"), keys.siteA),
    "snapshot-with-recording-fails-closed": ({ world, keys, ids }) => {
      const recording: PublishedAsset = {
        id: "asset-recording-01",
        url: "https://assets.example.com/a/recording-01.m4a",
        contentType: "audio/mp4" as PublishedAsset["contentType"],
        bytes: 4096,
        sha256: "2".repeat(64),
        alt: "",
        credit: null,
      };
      const publications = world.publications.map((item) => item.pageId !== ids.siteLive ? item : {
        ...item,
        snapshot: { ...item.snapshot, assets: [recording], markdown: renderMarkdown(item.snapshot.blocks, []) },
      });
      return get(withPublications(world, publications), docPath(SITE_A, ids.siteLive), keys.siteA);
    },

    // --- credentials ------------------------------------------------------------------
    "revoked-key-unauthenticated": ({ world, keys }) => get(world, listPath(SITE_A), keys.siteARevoked),
    "rotated-key-unauthenticated": ({ world, keys }) => get(world, listPath(SITE_A), keys.siteARotated),
    "removed-connection-unauthenticated": ({ world, keys }) => get(world, listPath(SITE_C), keys.siteCRemoved),
    "unknown-key-unauthenticated": ({ world, keys }) => get(world, listPath(SITE_A), keys.unknownKey),
    "other-connection-key-not-found": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.siteLive), keys.siteB),
    "other-face-token-not-found": ({ world, keys }) => get(world, listPath("niho"), keys.exp),
    "other-face-token-doc-not-found": ({ world, keys, ids }) => get(world, docPath("niho", ids.nihoLive), keys.exp),
    "face-token-on-site-handle-not-found": ({ world, keys }) => get(world, listPath(SITE_A), keys.exp),
    "site-key-on-face-handle-not-found": ({ world, keys }) => get(world, listPath("exp"), keys.siteA),
    "missing-authorization-unauthenticated": ({ world }) => get(world, listPath(SITE_A)),
    "non-bearer-authorization-unauthenticated": ({ world, keys }) =>
      get(world, listPath(SITE_A), undefined, { authorization: `Basic ${keys.siteA}` }),
    "multiple-authorization-unauthenticated": ({ world, keys }) =>
      get(world, listPath(SITE_A), undefined, { authorization: [`Bearer ${keys.siteA}`, `Bearer ${keys.siteB}`] }),
    "expired-face-token-unauthenticated": ({ world, keys }) => get(world, listPath("exp"), keys.expExpired),
    "revoked-face-token-unauthenticated": ({ world, keys }) => get(world, listPath("niho"), keys.nihoRevoked),

    // --- conditional requests -----------------------------------------------------------
    "revoked-key-if-none-match-unauthenticated": async ({ world, keys }) =>
      get(world, listPath(SITE_A), keys.siteARevoked, { "if-none-match": await etagOf(world, listPath(SITE_A), keys.siteA) }),
    "rotated-key-if-none-match-unauthenticated": async ({ world, keys, ids }) =>
      get(world, docPath(SITE_A, ids.siteLive), keys.siteARotated, {
        "if-none-match": await etagOf(world, docPath(SITE_A, ids.siteLive), keys.siteA),
      }),
    "expired-face-token-if-none-match-unauthenticated": async ({ world, keys }) =>
      get(world, listPath("exp"), keys.expExpired, { "if-none-match": await etagOf(world, listPath("exp"), keys.exp) }),
    "foreign-handle-if-none-match-not-found": async ({ world, keys }) =>
      get(world, listPath(SITE_A), keys.siteB, { "if-none-match": await etagOf(world, listPath(SITE_A), keys.siteA) }),
    "if-none-match-not-modified": async ({ world, keys, ids }) => {
      const url = docPath(SITE_A, ids.siteLive);
      const etag = await etagOf(world, url, keys.siteA);
      const response = await call(world, url, { credential: keys.siteA, headers: { "if-none-match": etag } });
      return { ...result(response), body: response.body !== null, etag: response.headers.etag === etag };
    },
    "if-none-match-star-not-modified": ({ world, keys }) => get(world, listPath(SITE_A), keys.siteA, { "if-none-match": "*" }),
    "if-none-match-weak-list-not-modified": async ({ world, keys }) => {
      const etag = await etagOf(world, listPath(SITE_A), keys.siteA);
      return get(world, listPath(SITE_A), keys.siteA, { "if-none-match": `"stale", W/${etag}` });
    },
    "if-none-match-stale-ok": ({ world, keys }) => get(world, listPath(SITE_A), keys.siteA, { "if-none-match": `"${"0".repeat(64)}"` }),

    // --- lists ----------------------------------------------------------------------------
    "list-excludes-other-dest": ({ world, keys, ids }) => listed(world, listPath(SITE_A), keys.siteA, ids.expLive),
    "list-excludes-other-connection": ({ world, keys, ids }) => listed(world, listPath(SITE_A), keys.siteA, ids.siteBLive),
    "face-list-excludes-other-face": ({ world, keys, ids }) => listed(world, listPath("exp"), keys.exp, ids.nihoLive),
    "list-excludes-unlisted-by-default": ({ world, keys, ids }) => listed(world, listPath("exp"), keys.exp, ids.expUnlisted),
    "list-includes-unlisted-for-face": ({ world, keys, ids }) => listed(world, listPath("exp", "?include=unlisted"), keys.exp, ids.expUnlisted),
    "site-include-unlisted-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?include=unlisted"), keys.siteA),
    "get-unlisted-face-ok": ({ world, keys, ids }) => get(world, docPath("exp", ids.expUnlisted), keys.exp),
    "include-unknown-invalid": ({ world, keys }) => get(world, listPath("exp", "?include=drafts"), keys.exp),
    "include-duplicate-invalid": ({ world, keys }) => get(world, listPath("exp", "?include=unlisted&include=unlisted"), keys.exp),
    "limit-zero-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?limit=0"), keys.siteA),
    "limit-over-max-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?limit=101"), keys.siteA),
    "limit-non-numeric-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?limit=ten"), keys.siteA),
    "limit-leading-zero-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?limit=050"), keys.siteA),
    "cursor-malformed-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?cursor=not-a-cursor"), keys.siteA),
    "cursor-empty-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?cursor="), keys.siteA),
    "unknown-query-invalid": ({ world, keys }) => get(world, listPath(SITE_A, "?sort=asc"), keys.siteA),
    "list-order-and-pagination": async ({ world, keys }) => {
      const bulk = manyPublications(9, 7);
      const paged = withPublications({ ...world, publications: [] }, bulk);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
        const response = await call(paged, listPath(SITE_A, query), { credential: keys.siteA });
        if (response.status !== 200) return result(response);
        const body = json(response) as { items: { id: string }[]; nextCursor: string | null };
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);
      const order = expectedOrder(bulk);
      return { status: 200, ordered: seen.join() === order.join(), pages };
    },
    "list-default-limit": async ({ world, keys }) => {
      const response = await call(withPublications(world, manyPublications(55, 11)), listPath(SITE_A), { credential: keys.siteA });
      if (response.status !== 200) return result(response);
      const body = json(response) as { items: unknown[]; nextCursor: string | null };
      return { status: 200, count: body.items.length, hasNext: body.nextCursor !== null };
    },

    // --- snapshots ---------------------------------------------------------------------
    "published-ignores-draft-edits": async ({ world, keys, ids }) => {
      const edited = editDraft(world, ids.siteLive);
      const response = await call(edited, docPath(SITE_A, ids.siteLive), { credential: keys.siteA });
      if (response.status !== 200) return result(response);
      const body = json(response);
      const published = world.publications.find((item) => item.pageId === ids.siteLive)?.snapshot;
      const same = body.title === published?.title && body.lead === published?.lead && body.updatedAt === published?.updatedAt
        && canonicalJson(body.blocks) === canonicalJson(published?.blocks);
      return { status: 200, source: same && !response.body?.includes("DRAFT-ONLY") ? "snapshot" : "draft" };
    },
    "list-ignores-draft-edits": async ({ world, keys, ids }) => {
      const response = await call(editDraft(world, ids.siteLive), listPath(SITE_A), { credential: keys.siteA });
      if (response.status !== 200) return result(response);
      const items = json(response).items as { id: string; title: string; updatedAt: string }[];
      const item = items.find((candidate) => candidate.id === ids.siteLive);
      const published = world.publications.find((candidate) => candidate.pageId === ids.siteLive)?.snapshot;
      const same = item?.title === published?.title && item?.updatedAt === published?.updatedAt;
      return { status: 200, source: same && !response.body?.includes("DRAFT-ONLY") ? "snapshot" : "draft" };
    },
    "republish-same-id-and-url": async ({ world, keys, ids }) => {
      const url = docPath(SITE_A, ids.stopped);
      const before = await call(world, url, { credential: keys.siteA });
      const stopped = world.publications.find((item) => item.pageId === ids.stopped);
      if (!stopped) throw new Error("fixture is missing the stopped page");
      const republished = withPublications(world, world.publications.map((item) => item !== stopped ? item : {
        ...item,
        stoppedAt: null,
        snapshot: { ...item.snapshot, version: 2, updatedAt: "2026-09-30T00:00:00.000Z" },
      }));
      const after = await call(republished, url, { credential: keys.siteA });
      const body = after.status === 200 ? json(after) : {};
      const listedAgain = await listed(republished, listPath(SITE_A), keys.siteA, ids.stopped);
      return {
        before: before.status,
        after: after.status,
        sameIdAndUrl: body.id === ids.stopped && body.canonicalUrl === stopped.snapshot.canonicalUrl,
        listed: listedAgain.listed,
      };
    },

    // --- preview -------------------------------------------------------------------------
    "preview-ok": async ({ world, keys }) => {
      const response = await call(world, previewPath(keys.previewExp), { credential: keys.exp });
      if (response.status !== 200) return result(response);
      const body = json(response) as { title: string; preview: { noindex: boolean } };
      return {
        status: 200,
        noindex: body.preview.noindex,
        cacheControl: response.headers["cache-control"],
        source: body.title.startsWith("DRAFT-ONLY") ? "draft" : "other",
      };
    },
    "preview-site-ok": ({ world, keys }) => get(world, previewPath(keys.previewSiteA), keys.siteA),
    "preview-expired-not-found": ({ world, keys }) => get(world, previewPath(keys.previewExpired), keys.exp),
    "preview-unknown-not-found": ({ world, keys }) => get(world, previewPath(keys.previewUnknown), keys.exp),
    "preview-malformed-token-not-found": ({ world, keys }) => get(world, previewPath("pv_short"), keys.exp),
    "preview-other-face-not-found": ({ world, keys }) => get(world, previewPath(keys.previewExp), keys.niho),
    "preview-other-connection-not-found": ({ world, keys }) => get(world, previewPath(keys.previewSiteA), keys.siteB),
    "preview-site-token-face-credential-not-found": ({ world, keys }) => get(world, previewPath(keys.previewSiteA), keys.exp),
    "preview-without-credential-unauthenticated": ({ world, keys }) => get(world, previewPath(keys.previewExp)),
    "preview-revoked-key-unauthenticated": ({ world, keys }) => get(world, previewPath(keys.previewSiteA), keys.siteARevoked),
    "preview-token-as-bearer-unauthenticated": ({ world, keys }) => get(world, listPath("exp"), keys.previewExp),
    "preview-token-as-published-id-invalid": ({ world, keys }) => get(world, docPath("exp", keys.previewExp), keys.exp),
    "preview-follows-edited-draft": async ({ world, keys, ids }) => {
      const response = await call(editDraft(world, ids.draft), previewPath(keys.previewExp), { credential: keys.exp });
      if (response.status !== 200) return result(response);
      const body = json(response) as { title: string };
      return { status: 200, source: body.title === "DRAFT-ONLY edited title" ? "current-draft" : "stale" };
    },
    "preview-ttl-over-limit-not-found": ({ world, keys }) => get(world, previewPath(keys.previewLongLived), keys.exp),

    // --- moved between destinations ------------------------------------------------------
    "gone-moved-face-to-face": ({ world, keys, ids }) => get(world, docPath("exp", ids.movedFaceToFace), keys.exp),
    "gone-face-stopped-no-moved-to": ({ world, keys, ids }) => get(world, docPath("exp", ids.faceStopped), keys.exp),
    "gone-moved-face-to-site-no-moved-to": ({ world, keys, ids }) => get(world, docPath("exp", ids.movedFaceToSite), keys.exp),
    "gone-moved-site-to-face-no-moved-to": ({ world, keys, ids }) => get(world, docPath(SITE_A, ids.movedSiteToFace), keys.siteA),
    "gone-moved-other-face-not-found": ({ world, keys, ids }) => get(world, docPath("exp", ids.movedFaceToFace), keys.niho),
    "gone-moved-target-stopped-no-moved-to": ({ world, keys, ids }) => get(world, docPath("exp", ids.movedTargetStopped), keys.exp),
    "moved-target-serves-new-url": async ({ world, keys, ids }) => {
      const response = await call(world, docPath("niho", ids.movedFaceToFace), { credential: keys.niho });
      return { ...result(response), canonicalUrl: response.status === 200 ? json(response).canonicalUrl : null };
    },

    // --- transport -------------------------------------------------------------------------
    "get-malformed-id-invalid": ({ world, keys }) => get(world, docPath(SITE_A, "not-a-uuid"), keys.siteA),
    "unsupported-method-invalid": async ({ world, keys }) => {
      const response = await call(world, listPath(SITE_A), { credential: keys.siteA, method: "POST" });
      return { ...result(response), allow: response.headers.allow };
    },
    "unknown-route-not-found": ({ world, keys }) => get(world, `/v1/${SITE_A}/drafts.json`, keys.siteA),
    "head-matches-get": async ({ world, keys, ids }) => {
      const url = docPath(SITE_A, ids.siteLive);
      const full = await call(world, url, { credential: keys.siteA });
      const head = await call(world, url, { credential: keys.siteA, method: "HEAD" });
      return { status: head.status, body: head.body !== null, sameHeaders: JSON.stringify(full.headers) === JSON.stringify(head.headers) };
    },
    "response-headers": async ({ world, keys, ids }) => {
      const ok = await call(world, docPath(SITE_A, ids.siteLive), { credential: keys.siteA });
      const preview = await call(world, previewPath(keys.previewExp), { credential: keys.exp });
      const missing = await call(world, docPath(SITE_A, ids.missing), { credential: keys.siteA });
      const unauthenticated = await call(world, listPath(SITE_A));
      const pick = (response: ReferenceResponse) => ({
        contentType: response.headers["content-type"],
        robots: response.headers["x-robots-tag"],
        cacheControl: response.headers["cache-control"],
        vary: response.headers.vary,
        strongEtag: /^"[0-9a-f]{64}"$/.test(response.headers.etag ?? ""),
        wwwAuthenticate: response.headers["www-authenticate"] ?? null,
      });
      return { ok: pick(ok), preview: pick(preview), missing: pick(missing), unauthenticated: pick(unauthenticated) };
    },
    "not-found-responses-identical": async ({ world, keys, ids }) => {
      const responses = await Promise.all([
        call(world, docPath(SITE_A, ids.missing), { credential: keys.siteA }),
        call(world, docPath(SITE_A, ids.draft), { credential: keys.siteA }),
        call(world, docPath(SITE_A, ids.private), { credential: keys.siteA }),
        call(world, docPath(SITE_A, ids.expLive), { credential: keys.siteA }),
        call(world, docPath(SITE_A, ids.siteBLive), { credential: keys.siteA }),
        call(world, docPath(SITE_B, ids.siteBLive), { credential: keys.siteA }),
        call(world, docPath(SITE_A, ids.stopped), { credential: keys.siteB }),
        call(world, listPath(SITE_B), { credential: keys.siteA }),
        call(world, listPath("exp"), { credential: keys.siteA }),
        call(world, previewPath(keys.previewUnknown), { credential: keys.exp }),
        call(world, previewPath(keys.previewExpired), { credential: keys.exp }),
        call(world, previewPath(keys.previewExp), { credential: keys.niho }),
      ]);
      const shapes = new Set(responses.map((response) => JSON.stringify([response.status, response.headers, response.body])));
      return { status: responses[0]?.status, identical: shapes.size === 1 };
    },
    "responses-never-contain-credentials": async ({ world, keys, ids }) => {
      const urls = [listPath(SITE_A), docPath(SITE_A, ids.siteLive), docPath(SITE_A, ids.stopped), previewPath(keys.previewSiteA), previewPath(keys.previewExp)];
      const credentials = [keys.siteA, keys.siteARevoked, keys.siteARotated, keys.siteB, keys.exp, keys.expExpired];
      const secrets = Object.values(keys);
      let leaks = false;
      for (const url of urls) {
        for (const credential of credentials) {
          const response = await call(world, url, { credential });
          const text = JSON.stringify(response);
          if (secrets.some((secret) => text.includes(secret))) leaks = true;
        }
      }
      return { leaks };
    },
  };
}
