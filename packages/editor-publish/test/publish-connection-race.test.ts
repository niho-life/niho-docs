/** A disconnect that lands between the pre-check and the publish transaction must not leave a live page. */

import { describe, expect, it } from "vitest";
import { PublishService, siteDeclarationSource, type ConnectionSource } from "../src/index.js";
import { MemoryAuthors, MemoryFacts, MemoryRoles, MemoryStorageMode, memoryAssetUrls } from "../test-support/memory-store.js";
import { ACTOR, HANDLE, PAGE_ID, SITE_SETTINGS, createSiteWorld } from "./support/site-world.js";

describe("publishing to a site whose connection was disconnected after the pre-check", () => {
  it("is refused inside the transaction and writes nothing", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    // Pre-check and declaration were read while the connection was still there.
    const staleDeclaration = await siteDeclarationSource(world.store, world.faces).get(HANDLE);
    expect(staleDeclaration).not.toBeNull();
    const stale: ConnectionSource = { has: async () => true };
    const authors = new MemoryAuthors();
    authors.set(ACTOR, { name: "Example Writer", handle: null, url: null });
    const facts = new MemoryFacts();
    facts.set(ACTOR, { relatedLive: true });
    const publisher = new PublishService({
      store: world.store,
      roles: new MemoryRoles(),
      storage: new MemoryStorageMode(),
      connections: stale,
      declarations: { get: async () => staleDeclaration },
      authors,
      facts,
      assetUrls: memoryAssetUrls(),
      clock: world.clock,
    });

    expect((await world.connections.disconnect({ actorId: ACTOR, connectionId })).ok).toBe(true);
    const before = world.store.dump();
    const result = await publisher.publish({ actorId: ACTOR, pageId: PAGE_ID, target: { dest: "site", handle: HANDLE }, settings: SITE_SETTINGS });

    expect(result).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
    expect(world.store.dump()).toBe(before);
  });
});
