/** #41 鍵: plaintext only in issue results, hashes only in the store, uniform null on every failed authentication. */

import { describe, expect, it } from "vitest";
import { isConnectionKey, sha256Hex } from "@niho/editor-publish-contract";
import { AuthenticationUnavailable, ConnectionService, type RandomSource } from "../src/index.js";
import { ManualClock, MemoryAssetBytes, MemoryPublishStore, memoryDraftFingerprints } from "../test-support/memory-store.js";
import { ACTOR, HANDLE, OTHER_HANDLE, SITE_URL, createSiteWorld, secretWindows } from "./support/site-world.js";

describe("plaintext keys", () => {
  it("appear only in the results of createConnection and rotateKey, never in the store, its dump or a view", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    const extra = await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: rotated.key.id });
    expect(extra.ok).toBe(true);
    expect((await world.publish()).ok).toBe(true);

    const dump = world.store.dump();
    expect(dump).toContain(await sha256Hex(key.plaintext));
    const outputs = [
      dump,
      JSON.stringify(world.store.snapshotState()),
      JSON.stringify(await world.connections.getConnectionView({ actorId: ACTOR, connectionId })),
      JSON.stringify(await world.connections.listPublished({ actorId: ACTOR, connectionId })),
      JSON.stringify(await world.connections.listConnections({ actorId: ACTOR })),
      JSON.stringify(extra),
    ];
    for (const plaintext of [key.plaintext, rotated.key.plaintext]) {
      for (const output of outputs) {
        expect(output).not.toContain(plaintext);
        for (const window of secretWindows(plaintext)) expect(output).not.toContain(window);
      }
    }
    // What is kept per key: its hash and its last 4 characters.
    for (const stored of world.store.keysOf(connectionId)) {
      expect(Object.keys(stored).sort()).toEqual(["connectionId", "createdAt", "id", "last4", "revokedAt", "sha256"]);
      expect(stored.last4).toHaveLength(4);
    }
  });

  it("are 256-bit ek_ keys, different every time", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const seen = new Set([key.plaintext]);
    for (let index = 0; index < 20; index += 1) {
      const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
      if (!rotated.ok) throw new Error(rotated.reason);
      expect(isConnectionKey(rotated.key.plaintext)).toBe(true);
      seen.add(rotated.key.plaintext);
    }
    expect(seen.size).toBe(21);
  });

  it("a broken random source fails the operation without writing anything", async () => {
    const store = new MemoryPublishStore();
    const broken: RandomSource = { bytes: () => new Uint8Array(3) };
    const service = new ConnectionService({ store, clock: new ManualClock(), drafts: memoryDraftFingerprints(store), assetBytes: new MemoryAssetBytes(), random: broken });
    const before = store.dump();
    expect(await service.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "api", siteUrl: SITE_URL })).toEqual({ ok: false, reason: "failed", retryable: true });
    expect(store.dump()).toBe(before);
  });
});

describe("authenticateKey", () => {
  it("returns the connection for a valid key", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect(await world.connections.authenticateKey(key.plaintext)).toEqual({ connectionId, handle: HANDLE });
  });

  it("answers the same null for malformed, unknown, revoked and removed-connection keys", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const revokedConnection = await world.connect({ handle: OTHER_HANDLE });
    await world.connections.revokeKey({ actorId: ACTOR, connectionId: revokedConnection.connectionId, keyId: revokedConnection.key.id });

    // A connection removed while its key is still active (only reachable by editing the store directly).
    const state = world.store.snapshotState();
    const removedStore = new MemoryPublishStore({
      ...state,
      connections: Object.fromEntries(Object.entries(state.connections).map(([id, record]) => [id, id === connectionId ? { ...record, removedAt: "2026-10-01T08:00:00.000Z" } : record])),
    });
    const removedService = new ConnectionService({ store: removedStore, clock: world.clock, drafts: memoryDraftFingerprints(removedStore), assetBytes: world.assetBytes });
    expect(removedStore.keysOf(connectionId).every((record) => record.revokedAt === null)).toBe(true);

    const unknown = `ek_${"A".repeat(42)}A`;
    const malformed: readonly unknown[] = [
      "", "ek_", key.plaintext.slice(0, -1), `${key.plaintext}A`, key.plaintext.toUpperCase().replace("EK_", "ek_"),
      `${key.plaintext.slice(0, -1)}B`, `pv_${key.plaintext.slice(3)}`, ` ${key.plaintext}`, `Bearer ${key.plaintext}`,
      null, undefined, 42, { key: key.plaintext }, [key.plaintext],
    ];
    const results: unknown[] = [];
    for (const candidate of malformed) results.push(await world.connections.authenticateKey(candidate));
    results.push(await world.connections.authenticateKey(unknown));
    results.push(await world.connections.authenticateKey(revokedConnection.key.plaintext));
    results.push(await removedService.authenticateKey(key.plaintext));
    for (const result of results) expect(result).toBeNull();
    // The removed store still answers for nothing; the original store still accepts the key.
    expect(await world.connections.authenticateKey(key.plaintext)).toEqual({ connectionId, handle: HANDLE });
  });

  it("a revocation counts from the very next call (nothing is cached)", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect(await world.connections.authenticateKey(key.plaintext)).not.toBeNull();
    expect((await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: key.id })).ok).toBe(true);
    expect(await world.connections.authenticateKey(key.plaintext)).toBeNull();
  });

  it("after rotateKey the old key no longer authenticates and the new one does", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(rotated.revoked).toBe(1);
    expect(await world.connections.authenticateKey(key.plaintext)).toBeNull();
    expect(await world.connections.authenticateKey(rotated.key.plaintext)).toEqual({ connectionId, handle: HANDLE });
    expect(world.store.keysOf(connectionId).map((record) => record.revokedAt === null)).toEqual([false, true]);
  });

  it("rotateKey revokes every active key, including ones from earlier rotations", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const store = world.store;
    // Two active keys (a store edited by hand); rotation must revoke both.
    const state = store.snapshotState();
    const [first] = Object.values(state.keys);
    if (!first) throw new Error("no key");
    const twin = { ...first, id: "11111111-1111-4111-8111-111111111111", sha256: "f".repeat(64), last4: "AAAA" };
    const doubled = new MemoryPublishStore({ ...state, keys: { ...state.keys, [twin.id]: twin } });
    const service = new ConnectionService({ store: doubled, clock: world.clock, drafts: memoryDraftFingerprints(doubled), assetBytes: world.assetBytes });
    const rotated = await service.rotateKey({ actorId: ACTOR, connectionId });
    expect(rotated).toMatchObject({ ok: true, revoked: 2 });
    expect(doubled.keysOf(connectionId).filter((record) => record.revokedAt === null)).toHaveLength(1);
  });

  it("revokeKey is idempotent: the same result every time", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const first = await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: key.id });
    const dump = world.store.dump();
    const second = await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: key.id });
    expect(first.ok && first.key.active).toBe(false);
    expect(second).toEqual(first);
    expect(world.store.dump()).toBe(dump);
    // With no active key left, rotateKey issues one.
    const issued = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    expect(issued).toMatchObject({ ok: true, revoked: 0 });
  });

  it("a store failure is not an answer: it throws a fixed error that carries no key", async () => {
    const world = createSiteWorld();
    const { key } = await world.connect();
    world.store.failOnCall(1);
    const error = await world.connections.authenticateKey(key.plaintext).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationUnavailable);
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(text).not.toContain(key.plaintext);
    for (const window of secretWindows(key.plaintext)) expect(text).not.toContain(window);
    expect((error as Error).cause).toBeUndefined();
  });

  it("failed results never carry a key", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    world.store.failOnCall(2);
    const failed = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    expect(failed).toEqual({ ok: false, reason: "failed", retryable: true });
    expect(Object.keys(failed)).toEqual(["ok", "reason", "retryable"]);
  });
});
