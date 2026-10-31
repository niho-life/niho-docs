/**
 * Synthetic worlds for the #41 tests: the connection service and the publish service share one memory
 * store, and PublishService reaches owners' sites through `connectionSource` / `siteDeclarationSource`
 * (not MemoryConnections). Every value is made up; keys are generated at run time by the service.
 */

import { createHash } from "node:crypto";
import {
  ConnectionService,
  PublishService,
  connectionSource,
  siteDeclarationSource,
  type AssetRecord,
  type CreateConnectionInput,
  type DraftPage,
  type IssuedKey,
  type PublishResult,
  type PublishSettings,
} from "../../src/index.js";
import {
  ManualClock,
  MemoryAssetBytes,
  MemoryAuthors,
  MemoryDeclarations,
  MemoryFacts,
  MemoryPublishStore,
  MemoryRoles,
  MemoryStorageMode,
  memoryAssetUrls,
  memoryDraftFingerprints,
} from "../../test-support/memory-store.js";
import { ACTOR, AUDIO, COVER, DECLARATIONS, FIGURE, OTHER_ACTOR, PAGE_ID, readyContent, readyPage } from "./world.js";

export { ACTOR, OTHER_ACTOR, PAGE_ID };

export const HANDLE = "field-notes";
export const OTHER_HANDLE = "other-notes";
export const SITE_URL = "https://notes.example.net";
export const MISSING_ID = "00000000-0000-4000-8000-000000000000";
export const SITE_SETTINGS: PublishSettings = { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] };

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Synthetic "photo" bytes (not a real image; only size and sha256 are checked). */
export function photoBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`synthetic photo bytes: ${label}`);
}

export function photoAsset(id: string, data: Uint8Array, patch: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id,
    kind: "image",
    bytes: data.byteLength,
    sha256: sha256(data),
    contentType: "image/jpeg",
    alt: "A synthetic photo",
    credit: "Example Photo Studio",
    consent: true,
    ...patch,
  };
}

export const COVER_BYTES = photoBytes("cover");
export const FIGURE_BYTES = photoBytes("harbor");
export const SITE_COVER = photoAsset(COVER.id, COVER_BYTES, { alt: "Shoreline at sunrise" });
export const SITE_FIGURE = photoAsset(FIGURE.id, FIGURE_BYTES, { contentType: "image/webp", alt: "Boats", credit: null });

export interface SiteWorld {
  readonly store: MemoryPublishStore;
  readonly clock: ManualClock;
  readonly assetBytes: MemoryAssetBytes;
  readonly faces: MemoryDeclarations;
  readonly connections: ConnectionService;
  readonly publisher: PublishService;
  connect(patch?: Partial<CreateConnectionInput>): Promise<{ readonly connectionId: string; readonly key: IssuedKey }>;
  publish(pageId?: string, handle?: string, actorId?: string): Promise<PublishResult>;
  addPage(id: string, patch?: Partial<DraftPage>, figure?: { readonly id: string; readonly data: Uint8Array }): void;
  editDraft(patch: Partial<DraftPage>, pageId?: string): void;
}

export function createSiteWorld(): SiteWorld {
  const store = new MemoryPublishStore();
  store.putPage(readyPage());
  for (const record of [SITE_COVER, SITE_FIGURE, AUDIO]) store.putAsset(PAGE_ID, record);
  const assetBytes = new MemoryAssetBytes();
  assetBytes.set(SITE_COVER.sha256, COVER_BYTES);
  assetBytes.set(SITE_FIGURE.sha256, FIGURE_BYTES);

  const roles = new MemoryRoles();
  roles.set(ACTOR, ["writer", "kamakura"]);
  roles.set(OTHER_ACTOR, ["writer"]);
  const faces = new MemoryDeclarations();
  faces.set("exp", DECLARATIONS.exp);
  faces.set("niho", DECLARATIONS.niho);
  const authors = new MemoryAuthors();
  authors.set(ACTOR, { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" });
  authors.set(OTHER_ACTOR, { name: "Another Writer", handle: null, url: null });
  const facts = new MemoryFacts();
  facts.set(ACTOR, { relatedLive: true });
  const clock = new ManualClock("2026-10-01T09:00:00.000Z", 60);

  const connections = new ConnectionService({ store, clock, drafts: memoryDraftFingerprints(store), assetBytes });
  const publisher = new PublishService({
    store,
    roles,
    storage: new MemoryStorageMode(),
    connections: connectionSource(store),
    declarations: siteDeclarationSource(store, faces),
    authors,
    facts,
    assetUrls: memoryAssetUrls(),
    clock,
  });

  return {
    store,
    clock,
    assetBytes,
    faces,
    connections,
    publisher,
    async connect(patch = {}) {
      const result = await connections.createConnection({ actorId: ACTOR, handle: HANDLE, mode: "api", siteUrl: SITE_URL, ...patch });
      if (!result.ok) throw new Error(`connect failed: ${result.reason}`);
      return { connectionId: result.connection.id, key: result.key };
    },
    publish(pageId = PAGE_ID, handle = HANDLE, actorId = ACTOR) {
      return publisher.publish({ actorId, pageId, target: { dest: "site", handle }, settings: SITE_SETTINGS });
    },
    addPage(id, patch = {}, figure = { id: `${FIGURE.id}-${id.slice(0, 4)}`, data: photoBytes(`harbor ${id}`) }) {
      const cover = { ...SITE_COVER, id: `${COVER.id}-${id.slice(0, 4)}` };
      const figureAsset = photoAsset(figure.id, figure.data, { contentType: "image/webp", alt: "Boats", credit: null });
      store.putPage(readyPage({
        id,
        coverAssetId: cover.id,
        content: JSON.parse(JSON.stringify(readyContent()).replaceAll(FIGURE.id, figure.id)) as unknown,
        ...patch,
      }));
      store.putAsset(id, cover);
      store.putAsset(id, figureAsset);
      assetBytes.set(figureAsset.sha256, figure.data);
    },
    editDraft(patch, pageId = PAGE_ID) {
      const page = store.page(pageId);
      if (!page) throw new Error("no page");
      store.putPage({ ...page, ...patch });
    },
  };
}

/** Every 8-character window of the key's random part: none of them may appear in stored data. */
export function secretWindows(plaintext: string): string[] {
  const secret = plaintext.slice("ek_".length);
  const windows: string[] = [];
  for (let index = 0; index + 8 <= secret.length; index += 1) windows.push(secret.slice(index, index + 8));
  return windows;
}
