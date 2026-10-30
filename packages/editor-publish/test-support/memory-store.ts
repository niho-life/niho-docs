/**
 * TEST-ONLY in-memory implementations of the ports of @niho/editor-publish.
 *
 * This is NOT a production store and must never hold real data. It exists so that the acceptance
 * behavior (atomic publish / update / stop / move, redirects, reserved slugs) can be checked without a
 * database. Transactions really roll back: the state at the start is kept and restored when the work or
 * the commit throws. Tests can make the k-th store call (every transaction method and the commit)
 * throw, to prove that a failure anywhere leaves the store exactly as it was.
 */

import { canonicalJson, type Author } from "@niho/editor-publish-contract";
import {
  placeKey,
  samePlace,
  type AssetRecord,
  type AssetUrls,
  type AuthorSource,
  type Clock,
  type ConnectionSource,
  type DeclarationSource,
  type DraftPage,
  type FactsQuery,
  type FactsSource,
  type Place,
  type PublicationRecord,
  type PublishStore,
  type PublishTx,
  type RedirectRecord,
  type RoleReader,
  type ServerFacts,
  type VersionRecord,
} from "../src/index.js";

export interface MemoryState {
  pages: Record<string, DraftPage>;
  assets: Record<string, { pageId: string; asset: AssetRecord }>;
  /** By page id. */
  publications: Record<string, PublicationRecord>;
  /** By `${pageId}#${version}`. */
  versions: Record<string, VersionRecord>;
  /** By `${handle}/${slug}` of `from`. */
  redirects: Record<string, RedirectRecord>;
}

/** Thrown by an injected fault. Carries no data. */
export class InjectedStoreFault extends Error {
  constructor() {
    super("injected store fault");
    this.name = "InjectedStoreFault";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozenClone<T>(value: T): T {
  const copy = clone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function emptyState(): MemoryState {
  return { pages: {}, assets: {}, publications: {}, versions: {}, redirects: {} };
}

const versionKey = (pageId: string, version: number): string => `${pageId}#${version}`;

export class MemoryPublishStore implements PublishStore {
  private state: MemoryState;
  private calls = 0;
  private failAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initial?: Partial<MemoryState>) {
    this.state = { ...emptyState(), ...clone(initial ?? {}) };
  }

  // --- test controls (not part of the port) ---

  /** Makes the k-th store call from now on throw (1-based). `null` turns injection off. Resets the count. */
  failOnCall(k: number | null): void {
    this.failAt = k;
    this.calls = 0;
  }

  /** Store calls (transaction methods and commits) since the last reset. */
  get callCount(): number {
    return this.calls;
  }

  resetCallCount(): void {
    this.calls = 0;
  }

  /** Canonical JSON of everything held: compare two dumps to prove nothing changed. */
  dump(): string {
    return canonicalJson(this.state);
  }

  snapshotState(): MemoryState {
    return clone(this.state);
  }

  putPage(page: DraftPage): void {
    this.state.pages[page.id] = clone(page);
  }

  putAsset(pageId: string, asset: AssetRecord): void {
    this.state.assets[asset.id] = { pageId, asset: clone(asset) };
  }

  page(pageId: string): DraftPage | null {
    const page = this.state.pages[pageId];
    return page ? frozenClone(page) : null;
  }

  publication(pageId: string): PublicationRecord | null {
    const publication = this.state.publications[pageId];
    return publication ? frozenClone(publication) : null;
  }

  versions(pageId: string): VersionRecord[] {
    return Object.values(this.state.versions)
      .filter((record) => record.pageId === pageId)
      .sort((a, b) => a.version - b.version)
      .map((record) => frozenClone(record));
  }

  redirects(): RedirectRecord[] {
    return Object.values(this.state.redirects).map((record) => frozenClone(record));
  }

  // --- port ---

  transaction<T>(work: (tx: PublishTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const before = clone(this.state);
      let active = true;
      const tx = this.createTx(() => active);
      try {
        const result = await work(tx);
        this.tick();
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      } finally {
        active = false;
      }
    };
    // One transaction at a time (serializable by construction).
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private tick(): void {
    this.calls += 1;
    if (this.failAt !== null && this.calls === this.failAt) throw new InjectedStoreFault();
  }

  private createTx(isActive: () => boolean): PublishTx {
    const enter = (): MemoryState => {
      if (!isActive()) throw new Error("transaction is closed");
      this.tick();
      return this.state;
    };
    return {
      getPage: async (pageId) => {
        const page = enter().pages[pageId];
        return page ? frozenClone(page) : null;
      },
      listAssets: async (pageId) =>
        Object.values(enter().assets)
          .filter((entry) => entry.pageId === pageId)
          .map((entry) => frozenClone(entry.asset)),
      getPublication: async (pageId) => {
        const publication = enter().publications[pageId];
        return publication ? frozenClone(publication) : null;
      },
      takenSlugs: async (handle, base, exceptPageId) => {
        const state = enter();
        const pattern = new RegExp(`^${base.replace(/[^a-z0-9-]/g, "")}(?:-[0-9]+)?$`);
        const taken = new Set<string>();
        for (const publication of Object.values(state.publications)) {
          if (publication.handle === handle && publication.pageId !== exceptPageId && pattern.test(publication.slug)) {
            taken.add(publication.slug);
          }
        }
        for (const redirect of Object.values(state.redirects)) {
          if (redirect.from.handle === handle && redirect.pageId !== exceptPageId && pattern.test(redirect.from.slug)) {
            taken.add(redirect.from.slug);
          }
        }
        return [...taken].sort();
      },
      latestVersion: async (pageId) => {
        let latest = 0;
        for (const record of Object.values(enter().versions)) {
          if (record.pageId === pageId && record.version > latest) latest = record.version;
        }
        return latest;
      },
      addVersion: async (record) => {
        const state = enter();
        const key = versionKey(record.pageId, record.version);
        if (state.versions[key]) throw new Error("version exists");
        state.versions[key] = clone(record);
      },
      putPublication: async (record) => {
        const state = enter();
        for (const other of Object.values(state.publications)) {
          if (other.pageId !== record.pageId && other.handle === record.handle && other.slug === record.slug) {
            throw new Error("unique (handle, slug)");
          }
        }
        state.publications[record.pageId] = clone(record);
      },
      listRedirectsTo: async (to: Place) =>
        Object.values(enter().redirects)
          .filter((redirect) => redirect.to !== "list" && samePlace(redirect.to, to))
          .map((redirect) => frozenClone(redirect)),
      putRedirect: async (record) => {
        enter().redirects[placeKey(record.from)] = clone(record);
      },
      deleteRedirect: async (from) => {
        delete enter().redirects[placeKey(from)];
      },
    };
  }
}

// --- the other ports --------------------------------------------------------------------

/** Roles by actor. Counts reads so tests can prove roles are read on every operation. */
export class MemoryRoles implements RoleReader {
  private readonly roles = new Map<string, readonly string[]>();
  reads = 0;

  set(actorId: string, roles: readonly string[]): void {
    this.roles.set(actorId, [...roles]);
  }

  async read(actorId: string): Promise<readonly string[]> {
    this.reads += 1;
    return [...(this.roles.get(actorId) ?? [])];
  }
}

export class MemoryConnections implements ConnectionSource {
  private readonly connections = new Set<string>();

  connect(actorId: string, handle: string): void {
    this.connections.add(`${actorId}\n${handle}`);
  }

  disconnect(actorId: string, handle: string): void {
    this.connections.delete(`${actorId}\n${handle}`);
  }

  async has(actorId: string, handle: string): Promise<boolean> {
    return this.connections.has(`${actorId}\n${handle}`);
  }
}

/** Declaration JSON by handle, as a destination would serve it (unvalidated). */
export class MemoryDeclarations implements DeclarationSource {
  private readonly declarations = new Map<string, unknown>();

  set(handle: string, json: unknown): void {
    this.declarations.set(handle, clone(json));
  }

  remove(handle: string): void {
    this.declarations.delete(handle);
  }

  async get(handle: string): Promise<unknown> {
    return this.declarations.has(handle) ? clone(this.declarations.get(handle)) : null;
  }
}

export class MemoryAuthors implements AuthorSource {
  private readonly authors = new Map<string, Author>();

  set(actorId: string, author: Author): void {
    this.authors.set(actorId, { ...author });
  }

  async read(actorId: string): Promise<Author> {
    const author = this.authors.get(actorId);
    if (!author) throw new Error("unknown author");
    return { ...author };
  }
}

/** `relatedLive` per actor (default unknown). Records the queries it saw. */
export class MemoryFacts implements FactsSource {
  private readonly facts = new Map<string, ServerFacts>();
  readonly queries: FactsQuery[] = [];

  set(actorId: string, facts: ServerFacts): void {
    this.facts.set(actorId, { ...facts });
  }

  async read(query: FactsQuery): Promise<ServerFacts> {
    this.queries.push(query);
    return { ...(this.facts.get(query.actorId) ?? { relatedLive: null }) };
  }
}

/** `https://{host}/a/{sha256}` — what an asset store serving content-addressed files would return. */
export function memoryAssetUrls(host = "assets.example.com"): AssetUrls {
  return { urlFor: (asset) => `https://${host}/a/${asset.sha256}` };
}

/** A deterministic clock: `now()` returns the current time, then moves it forward by `stepSeconds`. */
export class ManualClock implements Clock {
  private time: number;

  constructor(start = "2026-10-01T09:00:00.000Z", private readonly stepSeconds = 0) {
    this.time = Date.parse(start);
  }

  advance(seconds: number): void {
    this.time += seconds * 1000;
  }

  now(): string {
    const value = new Date(this.time).toISOString();
    this.time += this.stepSeconds * 1000;
    return value;
  }
}
