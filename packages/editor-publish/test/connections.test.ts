/** #41 接続: creating, reading and changing a connection, always scoped to its owner. */

import { describe, expect, it } from "vitest";
import { API_ORIGIN, RESERVED_HANDLES, isConnectionKey } from "@niho/editor-publish-contract";
import { isSiteUrl, isUrlShape, type ConnectionRef } from "../src/index.js";
import { ACTOR, HANDLE, MISSING_ID, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, SITE_URL, createSiteWorld } from "./support/site-world.js";

describe("createConnection", () => {
  it("creates a connection with fixed asset policy, no push, the default URL shape and a first key", async () => {
    const world = createSiteWorld();
    const result = await world.connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "wordpress", siteUrl: SITE_URL });
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection).toMatchObject({
      handle: HANDLE,
      mode: "wordpress",
      siteUrl: SITE_URL,
      urlShape: { host: "notes.example.net", path: "" },
      articleUrl: "https://notes.example.net/{slug}",
      apiUrl: `${API_ORIGIN}/v1/${HANDLE}/published.json`,
      assetPolicy: "copy-on-import",
      pushEnabled: false,
      removedAt: null,
    });
    expect(result.connection.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isConnectionKey(result.key.plaintext)).toBe(true);
    expect(result.key.masked).toBe(`ek_••••••••${result.key.plaintext.slice(-4)}`);
    expect(result.connection.keys).toEqual([{ id: result.key.id, masked: result.key.masked, createdAt: result.key.createdAt, revokedAt: null, active: true }]);
    expect(world.store.connection(result.connection.id)).toMatchObject({ ownerId: ACTOR, assetPolicy: "copy-on-import", pushEnabled: false });
  });

  it("accepts a URL shape with a path", async () => {
    const world = createSiteWorld();
    const result = await world.connections.createConnection({
      actorId: ACTOR, handle: HANDLE, mode: "api", siteUrl: SITE_URL, urlShape: { host: "blog.example.net", path: "posts" },
    });
    expect(result).toMatchObject({ ok: true, connection: { urlShape: { host: "blog.example.net", path: "posts" }, articleUrl: "https://blog.example.net/posts/{slug}" } });
  });

  const BAD_HANDLES: readonly unknown[] = ["", "ab", "a".repeat(33), "Field-notes", "-field", "field-", "field_notes", "field notes", "fïeld", 42, null, undefined];
  it.each(BAD_HANDLES.map((handle) => [JSON.stringify(handle) ?? "undefined", handle] as const))("refuses the handle %s", async (_label, handle) => {
    const world = createSiteWorld();
    const before = world.store.dump();
    expect(await world.connections.createConnection({ actorId: ACTOR, handle: handle as string, mode: "api", siteUrl: SITE_URL })).toEqual({ ok: false, reason: "invalid_handle" });
    expect(world.store.dump()).toBe(before);
  });

  it.each([...RESERVED_HANDLES])("refuses the reserved handle %s", async (handle) => {
    const world = createSiteWorld();
    expect(await world.connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: SITE_URL })).toEqual({ ok: false, reason: "invalid_handle" });
  });

  it("refuses a handle another connection holds, also after that connection was removed, also for another owner", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    expect(await world.connections.createConnection({ actorId: OTHER_ACTOR, handle: HANDLE, mode: "api", siteUrl: "https://other.example.net" }))
      .toEqual({ ok: false, reason: "handle_taken" });
    expect((await world.connections.disconnect({ actorId: ACTOR, connectionId })).ok).toBe(true);
    const before = world.store.dump();
    for (const actorId of [ACTOR, OTHER_ACTOR]) {
      expect(await world.connections.createConnection({ actorId, handle: HANDLE, mode: "api", siteUrl: SITE_URL })).toEqual({ ok: false, reason: "handle_taken" });
    }
    expect(world.store.dump()).toBe(before);
  });

  const credentialUrl = ["https://", "writer", ":", "pw", "@notes.example.net/"].join("");
  const BAD_SITE_URLS: readonly unknown[] = [
    "http://notes.example.net",
    "notes.example.net",
    "https://writer@notes.example.net/",
    credentialUrl,
    "https://notes.example.net:8443/",
    "https://xn--r8jz45g.example.net/",
    "https://例え.example.net/",
    "https://203.0.113.5/",
    "https://localhost/",
    "https://Notes.Example.net/",
    "https://notes.example.net/?ref=1",
    "https://notes.example.net/#top",
    "https://notes.example.net/a b",
    `https://notes.example.net/${"a".repeat(2100)}`,
    "javascript:alert(1)",
    "",
    7,
  ];
  it.each(BAD_SITE_URLS.map((url, index) => [index, url] as const))("refuses site URL #%i", async (_index, siteUrl) => {
    const world = createSiteWorld();
    expect(isSiteUrl(siteUrl)).toBe(false);
    expect(await world.connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "api", siteUrl: siteUrl as string })).toEqual({ ok: false, reason: "invalid_site_url" });
  });

  it("accepts https site URLs with a path", () => {
    for (const url of ["https://notes.example.net", "https://notes.example.net/", "https://www.notes.example.net/blog/"]) expect(isSiteUrl(url)).toBe(true);
  });

  const BAD_SHAPES: readonly unknown[] = [
    { host: "notes.example.net", path: "Posts" },
    { host: "notes.example.net", path: "posts/2026" },
    { host: "notes.example.net", path: "/posts" },
    { host: "notes.example.net", path: "a".repeat(65) },
    { host: "notes.example.net:8443", path: "" },
    { host: "localhost", path: "" },
    { host: "xn--r8jz45g.example.net", path: "" },
    { host: "notes.example.net" },
    { host: "notes.example.net", path: "", extra: true },
    "notes.example.net",
    null,
  ];
  it.each(BAD_SHAPES.map((shape, index) => [index, shape] as const))("refuses URL shape #%i", async (_index, urlShape) => {
    const world = createSiteWorld();
    expect(isUrlShape(urlShape)).toBe(false);
    expect(await world.connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "api", siteUrl: SITE_URL, urlShape: urlShape as never }))
      .toEqual({ ok: false, reason: "invalid_url_shape" });
  });

  it("refuses an unknown mode and a missing actor", async () => {
    const world = createSiteWorld();
    expect(await world.connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "medium" as never, siteUrl: SITE_URL })).toEqual({ ok: false, reason: "invalid_mode" });
    expect(await world.connections.createConnection({ actorId: "", handle: HANDLE, mode: "api", siteUrl: SITE_URL })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("only the owner sees a connection: everyone else gets the same not_found", () => {
  async function scoped() {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    expect((await world.publish()).ok).toBe(true);
    return { world, connectionId, keyId: key.id };
  }

  it("for every operation, another owner, a missing id and a malformed id are indistinguishable", async () => {
    const { world, connectionId, keyId } = await scoped();
    const refs: readonly ConnectionRef[] = [
      { actorId: OTHER_ACTOR, connectionId },
      { actorId: ACTOR, connectionId: MISSING_ID },
      { actorId: ACTOR, connectionId: "not-a-uuid" },
      { actorId: ACTOR, connectionId: connectionId.toUpperCase() },
      { actorId: "", connectionId },
    ];
    const before = world.store.dump();
    for (const ref of refs) {
      const results = [
        await world.connections.getConnectionView(ref),
        await world.connections.rotateKey(ref),
        await world.connections.revokeKey({ ...ref, keyId }),
        await world.connections.updateConnection({ ...ref, mode: "ghost" }),
        await world.connections.disconnect(ref),
        await world.connections.listPublished(ref),
        await world.connections.exportConnection(ref),
      ];
      for (const result of results) expect(result).toEqual({ ok: false, reason: "not_found" });
    }
    expect(world.store.dump()).toBe(before);
    // The owner still has everything.
    expect((await world.connections.getConnectionView({ actorId: ACTOR, connectionId })).ok).toBe(true);
    expect(world.store.publication(PAGE_ID)?.stoppedAt).toBeNull();
  });

  it("revokeKey with another connection's key id is not_found", async () => {
    const { world, connectionId } = await scoped();
    const other = await world.connect({ actorId: ACTOR, handle: OTHER_HANDLE });
    expect(await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: other.key.id })).toEqual({ ok: false, reason: "not_found" });
    expect(await world.connections.revokeKey({ actorId: ACTOR, connectionId, keyId: MISSING_ID })).toEqual({ ok: false, reason: "not_found" });
  });

  it("listConnections lists only the actor's live connections", async () => {
    const world = createSiteWorld();
    const first = await world.connect();
    await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE });
    const third = await world.connect({ handle: "third-notes" });
    const listed = await world.connections.listConnections({ actorId: ACTOR });
    expect(listed.ok && listed.connections.map((connection) => connection.handle)).toEqual([HANDLE, "third-notes"]);
    await world.connections.disconnect({ actorId: ACTOR, connectionId: first.connectionId });
    const after = await world.connections.listConnections({ actorId: ACTOR });
    expect(after.ok && after.connections.map((connection) => connection.id)).toEqual([third.connectionId]);
  });
});

describe("updateConnection", () => {
  it("never changes the handle", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const before = world.store.dump();
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, handle: "renamed-notes" } as never)).toEqual({ ok: false, reason: "handle_locked" });
    expect(world.store.dump()).toBe(before);
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, handle: HANDLE, mode: "ghost" } as never))
      .toMatchObject({ ok: true, connection: { handle: HANDLE, mode: "ghost" } });
  });

  it("validates what it changes and keeps the rest", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const before = world.store.dump();
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, siteUrl: "http://notes.example.net" })).toEqual({ ok: false, reason: "invalid_site_url" });
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, urlShape: { host: "notes.example.net", path: "a/b" } })).toEqual({ ok: false, reason: "invalid_url_shape" });
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, mode: "rss" as never })).toEqual({ ok: false, reason: "invalid_mode" });
    expect(world.store.dump()).toBe(before);
    const changed = await world.connections.updateConnection({ actorId: ACTOR, connectionId, siteUrl: "https://www.notes.example.net/" });
    expect(changed).toMatchObject({ ok: true, connection: { siteUrl: "https://www.notes.example.net/", urlShape: { host: "notes.example.net", path: "" }, mode: "api" } });
  });

  it("does not touch published versions: a new URL shape counts from the next 更新を公開", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const first = await world.publish();
    if (!first.ok) throw new Error(first.reason);
    expect(first.url).toBe("https://notes.example.net/a-morning-walk-along-the-coast");
    const versionBefore = JSON.stringify(world.store.versions(PAGE_ID));

    expect((await world.connections.updateConnection({ actorId: ACTOR, connectionId, urlShape: { host: "blog.example.net", path: "posts" } })).ok).toBe(true);
    expect(JSON.stringify(world.store.versions(PAGE_ID))).toBe(versionBefore);
    expect(world.store.publication(PAGE_ID)).toMatchObject({ version: 1, slug: "a-morning-walk-along-the-coast" });

    const updated = await world.publisher.update({ actorId: ACTOR, pageId: PAGE_ID, target: { dest: "site", handle: HANDLE }, settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] } });
    expect(updated).toMatchObject({ ok: true, version: 2, url: "https://blog.example.net/posts/a-morning-walk-along-the-coast" });
    const versions = world.store.versions(PAGE_ID);
    expect(versions.map((record) => record.snapshot.canonicalUrl)).toEqual([
      "https://notes.example.net/a-morning-walk-along-the-coast",
      "https://blog.example.net/posts/a-morning-walk-along-the-coast",
    ]);
  });

  it("is refused once the connection is removed", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    await world.connections.disconnect({ actorId: ACTOR, connectionId });
    expect(await world.connections.updateConnection({ actorId: ACTOR, connectionId, mode: "ghost" })).toEqual({ ok: false, reason: "disconnected" });
    expect(await world.connections.rotateKey({ actorId: ACTOR, connectionId })).toEqual({ ok: false, reason: "disconnected" });
  });
});

describe("getConnectionView", () => {
  it("shows the API URL, the URL shape, the mode and masked keys, and never a plaintext or a hash", async () => {
    const world = createSiteWorld();
    const { connectionId, key } = await world.connect();
    const rotated = await world.connections.rotateKey({ actorId: ACTOR, connectionId });
    if (!rotated.ok) throw new Error(rotated.reason);
    const view = await world.connections.getConnectionView({ actorId: ACTOR, connectionId });
    if (!view.ok) throw new Error(view.reason);
    expect(view.connection.apiUrl).toBe(`${API_ORIGIN}/v1/${HANDLE}/published.json`);
    expect(view.connection.pushEnabled).toBe(false);
    expect(view.connection.keys.map((entry) => entry.masked)).toEqual([rotated.key.masked, key.masked]);
    expect(view.connection.keys.map((entry) => entry.active)).toEqual([true, false]);
    const text = JSON.stringify(view);
    for (const plaintext of [key.plaintext, rotated.key.plaintext]) {
      expect(text).not.toContain(plaintext.slice(3, 20));
    }
    for (const stored of world.store.keysOf(connectionId)) expect(text).not.toContain(stored.sha256);
  });
});
