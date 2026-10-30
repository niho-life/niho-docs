/**
 * Integration with the contract's reference model: what ConnectionService and PublishService wrote,
 * mapped onto a `ReferenceWorld`, answered by `createReferenceServer` exactly as the public API v1 says.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePublishedDoc, parsePublishedIndex, sha256Hex, type PublishedIndex } from "@niho/editor-publish-contract";
import { createReferenceServer, type ReferenceResponse, type ReferenceServer, type ReferenceWorld } from "@niho/editor-publish-contract/test-support";
import { memoryAssetUrls } from "../test-support/memory-store.js";
import { toReferenceWorld } from "../test-support/reference-world.js";
import { ACTOR, HANDLE, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, createSiteWorld, type SiteWorld } from "./support/site-world.js";

const LIST = `/v1/${HANDLE}/published.json`;
const DOC = `/v1/${HANDLE}/published/${PAGE_ID}.json`;

async function referenceOf(world: SiteWorld): Promise<{ readonly world: ReferenceWorld; readonly server: ReferenceServer }> {
  const reference = await toReferenceWorld(world.store, { now: world.clock.now(), assetUrls: memoryAssetUrls() });
  return { world: reference, server: createReferenceServer(reference) };
}

function get(server: ReferenceServer, key: string, url: string, headers: Record<string, string> = {}): Promise<ReferenceResponse> {
  return server.handle({ method: "GET", url, headers: { authorization: `Bearer ${key}`, ...headers }, requestId: "req_test" });
}

function items(response: ReferenceResponse): readonly string[] {
  const parsed = parsePublishedIndex(JSON.parse(response.body ?? "null") as unknown, { dest: "site" });
  if (!parsed.ok) throw new Error("invalid index");
  return (parsed.value as PublishedIndex).items.map((item) => item.id);
}

/** A key minted by the test (never by the service), to look inside a world whose own keys cannot read any more. */
function probeKey(): string {
  for (;;) {
    const key = `ek_${randomBytes(32).toString("base64url")}`;
    if (/^ek_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(key)) return key;
  }
}

async function published(): Promise<{ world: SiteWorld; connectionId: string; key: string; otherKey: string }> {
  const world = createSiteWorld();
  const { connectionId, key } = await world.connect();
  const other = await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE, siteUrl: "https://other.example.net" });
  const result = await world.publish();
  if (!result.ok) throw new Error(result.reason);
  return { world, connectionId, key: key.plaintext, otherKey: other.key.plaintext };
}

describe("reference model: keys", () => {
  it("the key that came with the connection reads the list and the document", async () => {
    const { world, key } = await published();
    const { server } = await referenceOf(world);
    const list = await get(server, key, LIST);
    expect(list.status).toBe(200);
    expect(items(list)).toEqual([PAGE_ID]);
    const doc = await get(server, key, DOC);
    expect(doc.status).toBe(200);
    expect(parsePublishedDoc(JSON.parse(doc.body ?? "null") as unknown, { requireProjection: true }).ok).toBe(true);
  });

  it("after rotateKey: the old key is 401 (also with a matching If-None-Match), the new key is 200", async () => {
    const { world, connectionId, key } = await published();
    const before = await referenceOf(world);
    const etag = (await get(before.server, key, LIST)).headers.etag;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    const { server } = await referenceOf(world);

    const old = await get(server, key, LIST);
    expect(old.status).toBe(401);
    expect(old.headers["www-authenticate"]).toBe("Bearer");
    expect((await get(server, key, LIST, { "if-none-match": etag as string })).status).toBe(401);
    expect((await get(server, key, DOC)).status).toBe(401);

    const fresh = await get(server, rotated.key.plaintext, LIST);
    expect(fresh.status).toBe(200);
    expect(items(fresh)).toEqual([PAGE_ID]);
    expect((await get(server, rotated.key.plaintext, LIST, { "if-none-match": etag as string })).status).toBe(304);
    expect((await get(server, rotated.key.plaintext, DOC)).status).toBe(200);
  });

  it("revokeKey: the revoked key is 401 from the next request", async () => {
    const { world, connectionId, key } = await published();
    const view = await world.connections.getConnectionView({ actorId: ACTOR, connectionId });
    if (!view.ok) throw new Error(view.reason);
    await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: view.connection.keys[0]?.id ?? "" });
    const { server } = await referenceOf(world);
    expect((await get(server, key, LIST)).status).toBe(401);
  });

  it("another connection's key is 404 on this handle and reads only its own", async () => {
    const { world, otherKey } = await published();
    const { server } = await referenceOf(world);
    const foreign = await get(server, otherKey, LIST);
    expect(foreign.status).toBe(404);
    expect((await get(server, otherKey, DOC)).status).toBe(404);
    const own = await get(server, otherKey, `/v1/${OTHER_HANDLE}/published.json`);
    expect(own.status).toBe(200);
    expect(items(own)).toEqual([]);
  });

  it("the world holds hashes only", async () => {
    const { world, key, otherKey } = await published();
    const reference = await referenceOf(world);
    const text = JSON.stringify(reference.world);
    expect(text).toContain(await sha256Hex(key));
    for (const plaintext of [key, otherKey]) expect(text).not.toContain(plaintext.slice(3, 20));
  });
});

describe("reference model: disconnect", () => {
  it("every key of the connection is 401, also with an ETag taken before; another connection's key is 404", async () => {
    const { world, connectionId, key, otherKey } = await published();
    const before = await referenceOf(world);
    const etag = (await get(before.server, key, LIST)).headers.etag as string;
    const docEtag = (await get(before.server, key, DOC)).headers.etag as string;
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);

    expect((await world.connections.disconnect({ actorId: ACTOR, connectionId })).ok).toBe(true);
    const { server } = await referenceOf(world);
    for (const plaintext of [key, rotated.key.plaintext]) {
      const list = await get(server, plaintext, LIST);
      expect(list.status).toBe(401);
      expect((await get(server, plaintext, LIST, { "if-none-match": etag })).status).toBe(401);
      expect((await get(server, plaintext, DOC)).status).toBe(401);
      expect((await get(server, plaintext, DOC, { "if-none-match": docEtag })).status).toBe(401);
      // Same 401 as for a credential that never existed.
      expect(list.body).toBe((await get(server, "ek_never-issued", LIST)).body);
    }
    expect((await get(server, otherKey, LIST)).status).toBe(404);
    expect((await get(server, otherKey, `/v1/${OTHER_HANDLE}/published.json`)).status).toBe(200);
  });

  it("the pages are stopped in the world: gone from the list, 410 alone (seen through a test-only probe key)", async () => {
    const { world, connectionId } = await published();
    expect((await world.connections.disconnect({ actorId: ACTOR, connectionId })).ok).toBe(true);
    const { world: reference } = await referenceOf(world);
    const stopped = reference.publications.filter((publication) => publication.handle === HANDLE);
    expect(stopped.map((publication) => [publication.pageId, publication.stoppedAt !== null, publication.movedToHandle])).toEqual([[PAGE_ID, true, null]]);

    // The connection's own keys can no longer read (above). To check what the world holds, a probe key
    // is added to a copy in which the connection is not removed.
    const probe = probeKey();
    const probeHash = await sha256Hex(probe);
    const opened: ReferenceWorld = {
      ...reference,
      connections: reference.connections.map((connection) =>
        connection.handle === HANDLE ? { ...connection, removedAt: null, keys: [...connection.keys, { sha256: probeHash, revokedAt: null }] } : connection),
    };
    const server = createReferenceServer(opened);
    const list = await get(server, probe, LIST);
    expect(list.status).toBe(200);
    expect(items(list)).toEqual([]);
    const doc = await get(server, probe, DOC);
    expect(doc.status).toBe(410);
    expect(JSON.parse(doc.body ?? "null")).toEqual({ error: { code: "gone", requestId: "req_test", retryable: false } });
  });
});
