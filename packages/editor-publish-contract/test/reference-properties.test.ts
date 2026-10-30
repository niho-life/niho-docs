import { describe, expect, it } from "vitest";
import { destOfHandle, type FaceDest, type PublicationRange } from "../src/v1.js";
import {
  createReferenceServer,
  hashCredential,
  type ReferenceWorld,
  type WorldConnection,
  type WorldFaceCredential,
  type WorldPublication,
} from "../test-support/reference-server.js";
import { createRng, draftContent, minutesFrom, snapshot, syntheticKey, syntheticServiceToken, syntheticUuid, type Rng } from "./support/synthetic.js";

const NOW = "2026-10-01T00:00:00.000Z";
const WORLDS = 300;
const REQUESTS_PER_WORLD = 40;

type PageStatus = "draft" | "private" | "live" | "unlisted" | "stopped" | "moved";

interface Credential {
  readonly value: string;
  readonly valid: boolean;
  readonly kind: "site" | "face";
  /** The only handle this credential may read. */
  readonly reads: string;
}

interface Generated {
  readonly world: ReferenceWorld;
  readonly handles: readonly string[];
  readonly credentials: readonly Credential[];
  readonly pageIds: readonly string[];
  readonly hiddenIds: ReadonlySet<string>;
  readonly secrets: readonly string[];
}

const past = (rng: Rng): string => minutesFrom(NOW, -(1 + rng.int(20_000)));
const future = (rng: Rng): string => minutesFrom(NOW, 1 + rng.int(20_000));

async function generate(seed: number): Promise<Generated> {
  const rng = createRng(seed);
  const credentials: Credential[] = [];
  const connections: WorldConnection[] = [];
  const siteHandles = Array.from({ length: 1 + rng.int(3) }, (_, index) => `s${seed}-${index}`);
  for (const handle of siteHandles) {
    const removed = rng.chance(0.15);
    const keys = [];
    for (let index = 0; index < 1 + rng.int(3); index += 1) {
      const value = syntheticKey(rng);
      const state = rng.pick(["active", "revoked", "superseded", "revoking-later"] as const);
      const revokedAt = state === "active" ? null : state === "revoking-later" ? future(rng) : past(rng);
      keys.push({ sha256: await hashCredential(value), revokedAt });
      credentials.push({ value, valid: !removed && (state === "active" || state === "revoking-later"), kind: "site", reads: handle });
    }
    connections.push({ id: `connection-${handle}`, handle, ownerId: `owner-${handle}`, removedAt: removed ? past(rng) : null, keys });
  }
  const faceCredentials: WorldFaceCredential[] = [];
  for (const audience of ["exp", "niho"] as const satisfies readonly FaceDest[]) {
    for (let index = 0; index < 1 + rng.int(2); index += 1) {
      const value = syntheticServiceToken(rng);
      const state = rng.pick(["active", "expired", "revoked"] as const);
      faceCredentials.push({
        sha256: await hashCredential(value),
        audience,
        expiresAt: state === "expired" ? past(rng) : future(rng),
        revokedAt: state === "revoked" ? past(rng) : null,
      });
      credentials.push({ value, valid: state === "active", kind: "face", reads: audience });
    }
  }
  // Never stored anywhere.
  credentials.push({ value: syntheticKey(rng), valid: false, kind: "site", reads: siteHandles[0] ?? "s0-0" });
  credentials.push({ value: syntheticServiceToken(rng), valid: false, kind: "face", reads: "exp" });

  const handles = ["exp", "niho", ...siteHandles];
  const publications: WorldPublication[] = [];
  const pageIds: string[] = [];
  const hiddenIds = new Set<string>();
  const pages = [];
  for (let index = 0; index < 3 + rng.int(10); index += 1) {
    const id = syntheticUuid(rng);
    const slug = `page-${seed}-${index}`;
    pageIds.push(id);
    pages.push({ id, ownerId: "owner", draft: { revision: 1, savedAt: past(rng), content: draftContent(slug) } });
    const status = rng.pick(["draft", "private", "live", "unlisted", "stopped", "moved"] as const satisfies readonly PageStatus[]);
    if (status === "draft" || status === "private") {
      hiddenIds.add(id);
      continue;
    }
    const handle = rng.pick(handles);
    const dest = destOfHandle(handle) ?? "site";
    const range: PublicationRange = status === "unlisted" && dest !== "site" ? "unlisted" : "live";
    const updatedAt = minutesFrom("2026-09-01T00:00:00.000Z", rng.int(40_000));
    const base = { pageId: id, handle, range, movedToHandle: null, snapshot: snapshot({ id, dest, slug, title: `Published ${slug}`, updatedAt }) };
    if (status === "stopped" || status === "moved") {
      const target = status === "moved" ? rng.pick(handles.filter((candidate) => candidate !== handle)) : null;
      publications.push({ ...base, stoppedAt: past(rng), movedToHandle: target });
      if (target) {
        const targetDest = destOfHandle(target) ?? "site";
        publications.push({ ...base, handle: target, range: "live", stoppedAt: null, snapshot: snapshot({ id, dest: targetDest, slug, title: `Published ${slug}`, updatedAt: NOW }) });
      }
    } else {
      publications.push({ ...base, stoppedAt: null });
    }
  }
  return {
    world: { now: NOW, pages, publications, connections, faceCredentials, previewTokens: [] },
    handles,
    credentials,
    pageIds,
    hiddenIds,
    secrets: credentials.map((credential) => credential.value),
  };
}

describe("reference model properties", () => {
  it(`never serves drafts, private, unpublished or revoked access across ${WORLDS} random worlds`, async () => {
    const notFoundShapes = new Set<string>();
    let requests = 0;
    for (let seed = 1; seed <= WORLDS; seed += 1) {
      const generated = await generate(seed);
      const { world, handles, credentials, pageIds, hiddenIds, secrets } = generated;
      const server = createReferenceServer(world);
      const rng = createRng(seed * 7919);
      for (let index = 0; index < REQUESTS_PER_WORLD; index += 1) {
        requests += 1;
        const credential = rng.chance(0.05) ? undefined : rng.pick(credentials);
        const handle = rng.chance(0.7) && credential ? credential.reads : rng.pick(handles);
        const isList = rng.chance(0.4);
        const include = isList && rng.chance(0.4);
        const id = rng.pick(pageIds);
        const url = isList ? `/v1/${handle}/published.json${include ? "?include=unlisted" : ""}` : `/v1/${handle}/published/${id}.json`;
        const headers: Record<string, string> = {};
        if (credential) headers.authorization = `Bearer ${credential.value}`;
        if (rng.chance(0.3)) headers["if-none-match"] = "*";
        const response = await server.handle({ method: "GET", url, headers, requestId: "req_property" });
        const context = `seed ${seed} ${url}`;
        const text = JSON.stringify(response);

        expect(response.status, context).not.toBe(403);
        expect(response.status, context).not.toBe(503);
        expect(text.includes("DRAFT-ONLY"), context).toBe(false);
        for (const secret of secrets) expect(text.includes(secret), context).toBe(false);

        // Authentication first: no 304 / 404 / 410 without a valid credential.
        if (!credential?.valid) {
          expect(response.status, context).toBe(401);
          continue;
        }
        if (credential.reads !== handle) {
          expect(response.status, context).toBe(404);
        }
        if (response.status === 404) notFoundShapes.add(JSON.stringify([response.headers, response.body]));
        if (response.status === 400) {
          expect(isList && include && credential.kind === "site", context).toBe(true);
          continue;
        }

        const live = (publication: WorldPublication) => publication.handle === handle && publication.stoppedAt === null;
        if (isList) {
          if (response.status === 304) continue;
          if (credential.reads !== handle) continue;
          expect(response.status, context).toBe(200);
          const body = JSON.parse(response.body ?? "{}") as { items: { id: string; dest: string; range: string }[] };
          const expected = world.publications
            .filter((publication) => live(publication) && (publication.range === "live" || (include && credential.kind === "face")))
            .map((publication) => publication.pageId)
            .sort();
          expect(body.items.map((item) => item.id).sort(), context).toEqual(expected);
          for (const item of body.items) {
            expect(hiddenIds.has(item.id), context).toBe(false);
            expect(item.dest, context).toBe(destOfHandle(handle));
            if (item.range === "unlisted") expect(include && credential.kind === "face", context).toBe(true);
          }
          continue;
        }

        if (credential.reads !== handle) continue;
        const atHandle = world.publications.filter((publication) => publication.pageId === id && publication.handle === handle);
        const current = atHandle.find((publication) => publication.stoppedAt === null);
        if (current) {
          expect([200, 304], context).toContain(response.status);
        } else if (atHandle.length > 0) {
          expect(response.status, context).toBe(410);
          const body = JSON.parse(response.body ?? "{}") as { movedTo?: { dest: string } };
          const moved = atHandle[0]?.movedToHandle ?? null;
          const expectsMove = credential.kind === "face" && (moved === "exp" || moved === "niho");
          expect(body.movedTo !== undefined, context).toBe(expectsMove);
          if (body.movedTo) expect(body.movedTo.dest, context).toBe(moved);
        } else {
          expect(response.status, context).toBe(404);
        }
        if (response.status === 200) {
          const body = JSON.parse(response.body ?? "{}") as { id: string; title: string };
          expect(hiddenIds.has(body.id), context).toBe(false);
          expect(body.title.startsWith("Published "), context).toBe(true);
        }
      }
    }
    expect(requests).toBe(WORLDS * REQUESTS_PER_WORLD);
    // Every 404 is the same bytes, whatever the reason and whichever world.
    expect(notFoundShapes.size).toBe(1);
  }, 120_000);
});
