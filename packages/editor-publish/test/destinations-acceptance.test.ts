/**
 * The two acceptance rows of #41 (docs/architecture/editor-publish-core.md「受入との対応」), on the memory
 * store and on the contract's reference model.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isConnectionKey, sha256Hex } from "@niho/editor-publish-contract";
import { createReferenceServer, type ReferenceServer } from "@niho/editor-publish-contract/test-support";
import { deriveStatus, draftFingerprint, type DraftPage } from "../src/index.js";
import { memoryAssetUrls } from "../test-support/memory-store.js";
import { toReferenceWorld } from "../test-support/reference-world.js";
import { ACTOR, HANDLE, PAGE_ID, createSiteWorld, type SiteWorld } from "./support/site-world.js";

const LIST = `/v1/${HANDLE}/published.json`;
const DOC = `/v1/${HANDLE}/published/${PAGE_ID}.json`;

async function server(world: SiteWorld): Promise<ReferenceServer> {
  return createReferenceServer(await toReferenceWorld(world.store, { now: world.clock.now(), assetUrls: memoryAssetUrls() }));
}

const read = (reference: ReferenceServer, key: string, url: string) =>
  reference.handle({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

describe("鍵を再発行すると旧鍵で読めない", () => {
  it("rotateKey 後に authenticateKey(旧鍵) が null、新しい鍵は通る", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect(await world.connections.authenticateKey(key.plaintext)).toEqual({ connectionId, handle: HANDLE });
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(await world.connections.authenticateKey(key.plaintext)).toBeNull();
    expect(await world.connections.authenticateKey(rotated.key.plaintext)).toEqual({ connectionId, handle: HANDLE });
  });

  it("公開 API（参照モデル）でも旧鍵は 401、新しい鍵は 200", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect((await world.publish()).ok).toBe(true);
    expect((await read(await server(world), key.plaintext, LIST)).status).toBe(200);
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    const reference = await server(world);
    expect((await read(reference, key.plaintext, LIST)).status).toBe(401);
    expect((await read(reference, key.plaintext, DOC)).status).toBe(401);
    expect((await read(reference, rotated.key.plaintext, LIST)).status).toBe(200);
    expect((await read(reference, rotated.key.plaintext, DOC)).status).toBe(200);
  });
});

describe("接続を解除すると公開中のページは「公開をやめた」になる", () => {
  it("disconnect 後の deriveStatus が stopped、公開中の一覧が空、公開版と下書きは残る", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    expect((await world.publish()).ok).toBe(true);
    const versions = JSON.stringify(world.store.versions(PAGE_ID));

    const result = await world.connections.disconnect({ actorId: ACTOR, connectionId });
    expect(result).toMatchObject({ ok: true, stopped: 1 });

    const publication = world.store.publication(PAGE_ID);
    const fingerprint = world.store.versions(PAGE_ID).at(-1)?.snapshot.fingerprint ?? "";
    const draft = await draftFingerprint(world.store.page(PAGE_ID) as DraftPage, world.store.assetsOf(PAGE_ID));
    expect(publication && deriveStatus({ ...publication, fingerprint }, draft)).toBe("stopped");
    const listed = await world.connections.listPublished({ actorId: ACTOR, connectionId });
    expect(listed.ok && listed.items.map((item) => [item.pageId, item.status])).toEqual([[PAGE_ID, "stopped"]]);
    expect(listed.ok && listed.items.filter((item) => item.status !== "stopped")).toEqual([]);
    expect(JSON.stringify(world.store.versions(PAGE_ID))).toBe(versions);
    expect(world.store.page(PAGE_ID)).not.toBeNull();
    expect(world.store.redirects()).toEqual([]);
  });

  it("公開 API（参照モデル）では接続の鍵がすべて 401、公開版は一覧から消えて単体は 410", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect((await world.publish()).ok).toBe(true);
    await world.connections.disconnect({ actorId: ACTOR, connectionId });
    const reference = await toReferenceWorld(world.store, { now: world.clock.now(), assetUrls: memoryAssetUrls() });
    const api = createReferenceServer(reference);
    expect((await read(api, key.plaintext, LIST)).status).toBe(401);
    expect((await read(api, key.plaintext, DOC)).status).toBe(401);
    expect(reference.publications.filter((entry) => entry.handle === HANDLE).map((entry) => entry.stoppedAt !== null)).toEqual([true]);

    // No credential of the connection can read any more, so the content is checked with a test-only probe
    // key on a copy of the world in which the connection is not removed.
    let probe = "";
    while (!isConnectionKey(probe)) probe = `ek_${randomBytes(32).toString("base64url")}`;
    const probeHash = await sha256Hex(probe);
    const opened = createReferenceServer({
      ...reference,
      connections: reference.connections.map((connection) =>
        connection.handle === HANDLE ? { ...connection, removedAt: null, keys: [{ sha256: probeHash, revokedAt: null }] } : connection),
    });
    const list = await read(opened, probe, LIST);
    expect(list.status).toBe(200);
    expect((JSON.parse(list.body ?? "null") as { items: unknown[] }).items).toEqual([]);
    expect((await read(opened, probe, DOC)).status).toBe(410);
  });
});
