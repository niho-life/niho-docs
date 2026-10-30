/**
 * Atomicity of #41: for createConnection, rotateKey and disconnect, make the k-th store call throw for
 * every k from the first call to the commit. Each time the store must hold exactly what it held before
 * (no new key without the old one revoked, no half-removed connection, no page stopped alone) and the
 * result is `failed` (retryable). Then the same call without the fault succeeds.
 */

import { describe, expect, it } from "vitest";
import { ACTOR, HANDLE, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, SITE_URL, createSiteWorld, type SiteWorld } from "./support/site-world.js";

const PAGE_2 = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
const OTHER_PAGE = "8b2e4c6a-3d5f-4e70-8b92-1c3d4e5f6a70";

interface Prepared {
  readonly world: SiteWorld;
  readonly connectionId: string;
}

interface Operation {
  readonly name: string;
  readonly setup: () => Promise<Prepared>;
  readonly run: (prepared: Prepared) => Promise<{ readonly ok: boolean }>;
  /** Checked after the successful retry. */
  readonly after?: (prepared: Prepared) => Promise<void>;
}

async function withPages(): Promise<Prepared> {
  const world = createSiteWorld();
  const { connectionId } = await world.connect();
  await world.connections.rotateKey({ actorId: ACTOR, connectionId });
  await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE, siteUrl: "https://other.example.net" });
  world.addPage(PAGE_2, { title: "Second walk" });
  world.addPage(OTHER_PAGE, { ownerId: OTHER_ACTOR, title: "Someone else's walk" });
  for (const pageId of [PAGE_ID, PAGE_2]) {
    const published = await world.publish(pageId);
    if (!published.ok) throw new Error(published.reason);
  }
  const other = await world.publish(OTHER_PAGE, OTHER_HANDLE, OTHER_ACTOR);
  if (!other.ok) throw new Error(other.reason);
  return { world, connectionId };
}

const OPERATIONS: readonly Operation[] = [
  {
    name: "createConnection",
    setup: async () => {
      const world = createSiteWorld();
      const existing = await world.connect({ handle: OTHER_HANDLE });
      return { world, connectionId: existing.connectionId };
    },
    run: ({ world }) => world.connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "ghost", siteUrl: SITE_URL }),
    after: async ({ world }) => {
      const listed = await world.connections.listConnections({ actorId: ACTOR });
      expect(listed.ok && listed.connections.map((connection) => [connection.handle, connection.keys.length])).toEqual([[OTHER_HANDLE, 1], [HANDLE, 1]]);
    },
  },
  {
    name: "rotateKey",
    setup: withPages,
    run: ({ world, connectionId }) => world.connections.rotateKey({ actorId: ACTOR, connectionId }),
    after: async ({ world, connectionId }) => {
      expect(world.store.keysOf(connectionId).filter((key) => key.revokedAt === null)).toHaveLength(1);
    },
  },
  {
    name: "disconnect",
    setup: withPages,
    run: ({ world, connectionId }) => world.connections.disconnect({ actorId: ACTOR, connectionId }),
    after: async ({ world, connectionId }) => {
      expect(world.store.connection(connectionId)?.removedAt).not.toBeNull();
      expect(world.store.keysOf(connectionId).every((key) => key.revokedAt !== null)).toBe(true);
      expect([PAGE_ID, PAGE_2].map((pageId) => world.store.publication(pageId)?.stoppedAt === null)).toEqual([false, false]);
      expect(world.store.publication(OTHER_PAGE)?.stoppedAt).toBeNull();
    },
  },
];

describe("atomicity (#41): a store failure at any call leaves everything as it was", () => {
  it.each(OPERATIONS.map((operation) => [operation.name, operation] as const))("%s", async (_name, operation) => {
    const probe = await operation.setup();
    probe.world.store.resetCallCount();
    expect((await operation.run(probe)).ok).toBe(true);
    const calls = probe.world.store.callCount;
    expect(calls).toBeGreaterThanOrEqual(3);

    for (let k = 1; k <= calls; k += 1) {
      const prepared = await operation.setup();
      const before = prepared.world.store.dump();
      prepared.world.store.failOnCall(k);
      const result = await operation.run(prepared);
      expect(result, `call ${k} of ${calls}`).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(prepared.world.store.dump(), `call ${k} of ${calls}`).toBe(before);
      prepared.world.store.failOnCall(null);
      expect((await operation.run(prepared)).ok, `retry after call ${k}`).toBe(true);
      await operation.after?.(prepared);
    }
  });

  it("rotateKey: at no failure point does the old key stop working without a new one, or the other way round", async () => {
    const probe = await withPages();
    probe.world.store.resetCallCount();
    await probe.world.connections.rotateKey({ actorId: ACTOR, connectionId: probe.connectionId });
    const calls = probe.world.store.callCount;
    for (let k = 1; k <= calls; k += 1) {
      const prepared = await withPages();
      const active = prepared.world.store.keysOf(prepared.connectionId).filter((key) => key.revokedAt === null).map((key) => key.id);
      prepared.world.store.failOnCall(k);
      await prepared.world.connections.rotateKey({ actorId: ACTOR, connectionId: prepared.connectionId });
      prepared.world.store.failOnCall(null);
      expect(prepared.world.store.keysOf(prepared.connectionId).filter((key) => key.revokedAt === null).map((key) => key.id)).toEqual(active);
    }
  });
});
