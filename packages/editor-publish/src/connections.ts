/**
 * 発信先の設定 (#41): connections to owners' sites, their keys, disconnecting, the pages published on a
 * connection and the export. Spec: docs/architecture/editor-publish-core.md「#41 発信先の設定」,
 * docs/security/editor-publish-api-v1.md「呼び出し元と認証」.
 *
 * - A plaintext key exists only in the result of `createConnection` and `rotateKey`. The store keeps its
 *   SHA-256 and last 4 characters; views show `ek_••••••••` + those 4 characters.
 * - `rotateKey` adds the new key and revokes every active one in ONE transaction. `disconnect` revokes
 *   every key, removes the connection and stops every live page on its handle in ONE transaction.
 *   Nothing is cached: a revocation counts from the next call.
 * - Every operation is scoped to the owner. Another owner's connection and a missing one are the same
 *   `not_found`.
 * - `authenticateKey` answers `null` for every failure (malformed, unknown, revoked, removed), without
 *   saying which.
 * - Handles are never given to another connection, removed ones included, so a handle always means the
 *   same owner (its stopped pages and its export stay theirs).
 * - Errors and results never carry keys, page text, asset bytes or author data; failures carry codes.
 */

import {
  API_ORIGIN,
  BLOCK_TYPES,
  CONNECTION_KEY_PREFIX,
  MARK_TYPES,
  MASKED_KEY_PREFIX,
  SHA256_PATTERN,
  UUID_PATTERN,
  isConnectionHandle,
  isConnectionKey,
  isHttpsUrl,
  sha256Hex,
} from "@niho/editor-publish-contract";
import { DECLARATION_LIMITS, DECLARATION_SCHEMA_VERSION, destinationUrl, isDeclarationHost, parseDestinationDeclaration } from "./declaration.js";
import { buildExportArchive, type ExportArchive, type ExportArchiveFailure, type ExportDoc } from "./export.js";
import { webCryptoBytes } from "./runtime.js";
import type { Clock, ConnectionSource, DeclarationSource, Failed, NotFound, PublicationRecord, PublishTx, VersionRecord } from "./service.js";
import { deriveStatus, type StatusState } from "./status.js";

// --- records --------------------------------------------------------------------------

/** How the site receives pages. Every mode is read through the public API; WordPress / Ghost push is not on in v1. */
export const CONNECTION_MODES = ["api", "wordpress", "ghost"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

/** 写真の扱い: the site copies photos when it imports a page. Fixed in v1. */
export const ASSET_POLICY = "copy-on-import" as const;
export type AssetPolicy = typeof ASSET_POLICY;

/** Article URLs are `https://{host}/{path}/{slug}` (`https://{host}/{slug}` when `path` is empty). */
export interface UrlShape {
  readonly host: string;
  readonly path: string;
}

export interface ConnectionRecord {
  readonly id: string;
  readonly ownerId: string;
  /** Fixed at creation. Never reused, even after the connection is removed. */
  readonly handle: string;
  readonly mode: ConnectionMode;
  /** The site's https URL (shown, and the default host of `urlShape`). */
  readonly siteUrl: string;
  readonly urlShape: UrlShape;
  readonly assetPolicy: AssetPolicy;
  readonly pushEnabled: false;
  readonly createdAt: string;
  readonly removedAt: string | null;
}

/** Never the plaintext: its SHA-256 (hex) and its last 4 characters only. */
export interface KeyRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly sha256: string;
  readonly last4: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

// --- ports ----------------------------------------------------------------------------

/**
 * One transaction over connections, keys and everything `PublishTx` holds (publications and
 * versions), so that disconnecting can stop pages atomically. Every method may throw; the store then
 * rolls the whole transaction back.
 */
export interface ConnectionTx extends PublishTx {
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  /** Removed connections included. */
  getConnectionByHandle(handle: string): Promise<ConnectionRecord | null>;
  /** Removed connections included. */
  listConnections(ownerId: string): Promise<readonly ConnectionRecord[]>;
  /** Adds or replaces by id. Must fail when another connection holds the handle (removed ones included). */
  putConnection(record: ConnectionRecord): Promise<void>;
  listKeys(connectionId: string): Promise<readonly KeyRecord[]>;
  findKeyBySha256(sha256: string): Promise<KeyRecord | null>;
  /** Adds or replaces by id. Must fail when another key has the same hash. */
  putKey(record: KeyRecord): Promise<void>;
  /** Publications (live or stopped) whose handle is `handle`. */
  listPublicationsByHandle(handle: string): Promise<readonly PublicationRecord[]>;
  getVersion(pageId: string, version: number): Promise<VersionRecord | null>;
}

export interface ConnectionStore {
  /** Commits when `work` resolves, rolls back everything when it (or the commit) throws. */
  transaction<T>(work: (tx: ConnectionTx) => Promise<T>): Promise<T>;
}

/** Cryptographically secure random bytes. */
export interface RandomSource {
  bytes(n: number): Uint8Array;
}

/** Web Crypto `getRandomValues`. */
export const webCryptoRandom: RandomSource = { bytes: webCryptoBytes };

/** Reads a published photo's bytes from the asset store (for the export). `null` when it cannot be found. */
export interface AssetBytes {
  read(asset: { readonly id: string; readonly sha256: string; readonly contentType: string }): Promise<Uint8Array | null>;
}

/** The current draft's fingerprint (`draftFingerprint`) for "更新あり"; `null` when the page has no draft. */
export interface DraftFingerprints {
  read(pageId: string): Promise<string | null>;
}

export interface ConnectionPorts {
  readonly store: ConnectionStore;
  readonly clock: Clock;
  readonly drafts: DraftFingerprints;
  readonly assetBytes: AssetBytes;
  /** Defaults to `webCryptoRandom`. */
  readonly random?: RandomSource;
}

// --- inputs, views and results --------------------------------------------------------

export interface ConnectionRef {
  readonly actorId: string;
  readonly connectionId: string;
}

export interface CreateConnectionInput {
  readonly actorId: string;
  readonly handle: string;
  readonly mode: ConnectionMode;
  readonly siteUrl: string;
  /** Defaults to the host of `siteUrl` and an empty path. */
  readonly urlShape?: UrlShape;
}

/** `handle` cannot be changed; passing a different one is `handle_locked`. */
export interface UpdateConnectionInput extends ConnectionRef {
  readonly siteUrl?: string;
  readonly urlShape?: UrlShape;
  readonly mode?: ConnectionMode;
}

export interface RevokeKeyInput extends ConnectionRef {
  readonly keyId: string;
}

/** A newly issued key. The only place its plaintext ever appears: show it once, never store or log it. */
export interface IssuedKey {
  readonly id: string;
  readonly plaintext: string;
  readonly masked: string;
  readonly createdAt: string;
}

export interface KeyView {
  readonly id: string;
  /** `ek_••••••••` + the last 4 characters. */
  readonly masked: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

/** What the destination's settings page shows. Never a plaintext key or a hash. */
export interface ConnectionView {
  readonly id: string;
  readonly handle: string;
  readonly mode: ConnectionMode;
  readonly siteUrl: string;
  readonly urlShape: UrlShape;
  /** `https://{host}/{path}/{slug}` with a literal `{slug}`. */
  readonly articleUrl: string;
  /** `${API_ORIGIN}/v1/{handle}/published.json`. */
  readonly apiUrl: string;
  readonly assetPolicy: AssetPolicy;
  readonly pushEnabled: false;
  readonly createdAt: string;
  readonly removedAt: string | null;
  /** Newest first. */
  readonly keys: readonly KeyView[];
}

/** A page published on the connection (stopped ones included), as published (title and URL of the version). */
export interface PublishedOnConnection {
  readonly pageId: string;
  readonly title: string;
  readonly url: string;
  readonly slug: string;
  readonly status: Exclude<StatusState, "private">;
  readonly version: number;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly stoppedAt: string | null;
}

export interface AuthenticatedConnection {
  readonly connectionId: string;
  readonly handle: string;
}

type Refusal<R extends string> = { readonly ok: false; readonly reason: R };
export type InvalidHandle = Refusal<"invalid_handle">;
export type HandleTaken = Refusal<"handle_taken">;
export type HandleLocked = Refusal<"handle_locked">;
export type InvalidMode = Refusal<"invalid_mode">;
export type InvalidSiteUrl = Refusal<"invalid_site_url">;
export type InvalidUrlShape = Refusal<"invalid_url_shape">;
/** The connection was removed: keys cannot be issued and settings cannot change any more. */
export type Disconnected = Refusal<"disconnected">;

export type CreateConnectionResult =
  | { readonly ok: true; readonly connection: ConnectionView; readonly key: IssuedKey }
  | NotFound | InvalidHandle | HandleTaken | InvalidMode | InvalidSiteUrl | InvalidUrlShape | Failed;

export type RotateKeyResult =
  | { readonly ok: true; readonly key: IssuedKey; readonly revoked: number }
  | NotFound | Disconnected | Failed;

export type RevokeKeyResult = { readonly ok: true; readonly key: KeyView } | NotFound | Failed;

export type UpdateConnectionResult =
  | { readonly ok: true; readonly connection: ConnectionView }
  | NotFound | Disconnected | HandleLocked | InvalidMode | InvalidSiteUrl | InvalidUrlShape | Failed;

export type DisconnectResult =
  | { readonly ok: true; readonly connection: ConnectionView; readonly revokedKeys: number; readonly stopped: number }
  | NotFound | Failed;

export type ConnectionViewResult = { readonly ok: true; readonly connection: ConnectionView } | NotFound | Failed;

export type ListConnectionsResult = { readonly ok: true; readonly connections: readonly ConnectionView[] } | NotFound | Failed;

export type ListPublishedResult = { readonly ok: true; readonly items: readonly PublishedOnConnection[] } | NotFound | Failed;

export type ExportConnectionResult = ExportArchive | ExportArchiveFailure | NotFound | Failed;

const NOT_FOUND: NotFound = Object.freeze({ ok: false, reason: "not_found" });
const FAILED: Failed = Object.freeze({ ok: false, reason: "failed", retryable: true });
const refusal = <R extends string>(reason: R): Refusal<R> => Object.freeze({ ok: false, reason });
const INVALID_HANDLE = refusal("invalid_handle");
const HANDLE_TAKEN = refusal("handle_taken");
const HANDLE_LOCKED = refusal("handle_locked");
const INVALID_MODE = refusal("invalid_mode");
const INVALID_SITE_URL = refusal("invalid_site_url");
const INVALID_URL_SHAPE = refusal("invalid_url_shape");
const DISCONNECTED = refusal("disconnected");

/** Thrown by `authenticateKey` when the store cannot answer (so callers answer 503, not 401). Carries no data. */
export class AuthenticationUnavailable extends Error {
  constructor() {
    super("authentication unavailable");
    this.name = "AuthenticationUnavailable";
  }
}

// --- validation -------------------------------------------------------------------------

export const SITE_URL_MAX_LENGTH = 2048;
const URL_PATH = /^[a-z0-9-]*$/;
const LAST4 = /^[A-Za-z0-9_-]{4}$/;

export function isConnectionMode(value: unknown): value is ConnectionMode {
  return typeof value === "string" && (CONNECTION_MODES as readonly string[]).includes(value);
}

/**
 * An https URL of the site: no credentials, no port, no IDN / IP literal, a lowercase DNS host with at
 * least one dot, no query or fragment.
 */
export function isSiteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > SITE_URL_MAX_LENGTH || !isHttpsUrl(value)) return false;
  if (value.includes("?") || value.includes("#")) return false;
  return isDeclarationHost(siteHostOf(value));
}

function siteHostOf(siteUrl: string): string {
  return siteUrl.slice("https://".length).split("/", 1)[0] ?? "";
}

/** The rules of a declaration's `host` and `path` (#39): a DNS host, and one lowercase segment or nothing. */
export function isUrlShape(value: unknown): value is UrlShape {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("host") || !keys.includes("path")) return false;
  const { host, path } = value as { host?: unknown; path?: unknown };
  return isDeclarationHost(host) && typeof path === "string" && path.length <= DECLARATION_LIMITS.maxPath && URL_PATH.test(path);
}

function validRef(ref: unknown): ref is ConnectionRef {
  if (typeof ref !== "object" || ref === null) return false;
  const { actorId, connectionId } = ref as Partial<Record<keyof ConnectionRef, unknown>>;
  return typeof actorId === "string" && actorId !== "" && typeof connectionId === "string" && UUID_PATTERN.test(connectionId);
}

// --- keys -------------------------------------------------------------------------------

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url. */
function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const rest = bytes.length - index;
    const n = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += BASE64URL.charAt((n >>> 18) & 63) + BASE64URL.charAt((n >>> 12) & 63);
    if (rest > 1) out += BASE64URL.charAt((n >>> 6) & 63);
    if (rest > 2) out += BASE64URL.charAt(n & 63);
  }
  return out;
}

/** A random (version 4) UUID in lowercase. */
function uuidFrom(random: Uint8Array): string {
  const bytes = Uint8Array.from(random);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function maskedOf(last4: string): string {
  return LAST4.test(last4) ? `${MASKED_KEY_PREFIX}${last4}` : MASKED_KEY_PREFIX;
}

function keyView(key: KeyRecord): KeyView {
  return { id: key.id, masked: maskedOf(key.last4), createdAt: key.createdAt, revokedAt: key.revokedAt, active: key.revokedAt === null };
}

function byNewest<T extends { readonly createdAt: string; readonly id: string }>(a: T, b: T): number {
  return a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function connectionView(connection: ConnectionRecord, keys: readonly KeyRecord[]): ConnectionView {
  const urlShape = { host: connection.urlShape.host, path: connection.urlShape.path };
  return {
    id: connection.id,
    handle: connection.handle,
    mode: connection.mode,
    siteUrl: connection.siteUrl,
    urlShape,
    articleUrl: destinationUrl(urlShape, "{slug}"),
    apiUrl: `${API_ORIGIN}/v1/${connection.handle}/published.json`,
    assetPolicy: ASSET_POLICY,
    pushEnabled: false,
    createdAt: connection.createdAt,
    removedAt: connection.removedAt,
    keys: keys.filter((key) => key.connectionId === connection.id).sort(byNewest).map(keyView),
  };
}

// --- the site's declaration and the adapters for PublishService ------------------------------

/** The declaration editor builds for a connected site: no conditions, `live` only, no extras, every block and mark. */
export function siteDeclarationOf(connection: Pick<ConnectionRecord, "handle" | "urlShape">): Record<string, unknown> {
  const { host, path } = connection.urlShape;
  return {
    schemaVersion: DECLARATION_SCHEMA_VERSION,
    id: "site",
    label: host.length <= DECLARATION_LIMITS.maxLabel ? host : connection.handle,
    host,
    path,
    ranges: ["live"],
    extras: [],
    accepts: { blocks: [...BLOCK_TYPES], marks: [...MARK_TYPES] },
    requires: [],
  };
}

/** `ConnectionSource` (#39): the actor owns a connection with this handle that is not removed. */
export function connectionSource(store: ConnectionStore): ConnectionSource {
  return {
    async has(actorId, handle) {
      if (typeof actorId !== "string" || actorId === "" || !isConnectionHandle(handle)) return false;
      const connection = await store.transaction((tx) => tx.getConnectionByHandle(handle));
      return connection !== null && connection.ownerId === actorId && connection.removedAt === null;
    },
  };
}

/**
 * `DeclarationSource` (#39) for connected sites, built from the connection's settings (so a changed URL
 * shape counts from the next publish / update). Removed and unknown connections: `null`, which
 * PublishService treats as `destination_unavailable`. Other handles (the faces) go to `others`.
 */
export function siteDeclarationSource(store: ConnectionStore, others?: DeclarationSource): DeclarationSource {
  return {
    async get(handle) {
      if (!isConnectionHandle(handle)) return others ? others.get(handle) : null;
      const connection = await store.transaction((tx) => tx.getConnectionByHandle(handle));
      if (connection === null || connection.removedAt !== null) return null;
      const declaration = siteDeclarationOf(connection);
      // Fail closed if the stored settings ever stop making a valid declaration.
      return parseDestinationDeclaration(declaration).ok ? declaration : null;
    },
  };
}

// --- the service ----------------------------------------------------------------------------

export class ConnectionService {
  private readonly random: RandomSource;

  constructor(private readonly ports: ConnectionPorts) {
    this.random = ports.random ?? webCryptoRandom;
  }

  /** Creates a connection and its first key. The key's plaintext is in this result only. */
  async createConnection(input: CreateConnectionInput): Promise<CreateConnectionResult> {
    try {
      const { actorId, handle, mode, siteUrl, urlShape } = (input ?? {}) as Partial<Record<keyof CreateConnectionInput, unknown>>;
      if (typeof actorId !== "string" || actorId === "") return NOT_FOUND;
      if (!isConnectionHandle(handle)) return INVALID_HANDLE;
      if (!isConnectionMode(mode)) return INVALID_MODE;
      if (!isSiteUrl(siteUrl)) return INVALID_SITE_URL;
      const shape = urlShape === undefined ? { host: siteHostOf(siteUrl), path: "" } : urlShape;
      if (!isUrlShape(shape)) return INVALID_URL_SHAPE;

      const now = this.ports.clock.now();
      const id = uuidFrom(this.randomBytes(16));
      const minted = await this.mintKey(id, now);
      const connection: ConnectionRecord = {
        id,
        ownerId: actorId,
        handle,
        mode,
        siteUrl,
        urlShape: { host: shape.host, path: shape.path },
        assetPolicy: ASSET_POLICY,
        pushEnabled: false,
        createdAt: now,
        removedAt: null,
      };
      return await this.ports.store.transaction(async (tx): Promise<CreateConnectionResult> => {
        if ((await tx.getConnectionByHandle(handle)) !== null) return HANDLE_TAKEN;
        await tx.putConnection(connection);
        await tx.putKey(minted.record);
        return { ok: true, connection: connectionView(connection, [minted.record]), key: minted.issued };
      });
    } catch {
      return FAILED;
    }
  }

  /** The actor's connections that are not removed, oldest first. */
  async listConnections(input: { readonly actorId: string }): Promise<ListConnectionsResult> {
    try {
      const actorId = (input as { actorId?: unknown } | null)?.actorId;
      if (typeof actorId !== "string" || actorId === "") return NOT_FOUND;
      return await this.ports.store.transaction(async (tx): Promise<ListConnectionsResult> => {
        const connections = (await tx.listConnections(actorId))
          .filter((connection) => connection.ownerId === actorId && connection.removedAt === null)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.handle < b.handle ? -1 : 1));
        const views: ConnectionView[] = [];
        for (const connection of connections) views.push(connectionView(connection, await tx.listKeys(connection.id)));
        return { ok: true, connections: views };
      });
    } catch {
      return FAILED;
    }
  }

  /** What the settings page shows. Also after the connection is removed. */
  async getConnectionView(ref: ConnectionRef): Promise<ConnectionViewResult> {
    try {
      if (!validRef(ref)) return NOT_FOUND;
      return await this.ports.store.transaction(async (tx): Promise<ConnectionViewResult> => {
        const connection = await this.owned(tx, ref);
        if (!connection) return NOT_FOUND;
        return { ok: true, connection: connectionView(connection, await tx.listKeys(connection.id)) };
      });
    } catch {
      return FAILED;
    }
  }

  /**
   * Issues a new key and revokes every active key, in one transaction. Works with no active key too
   * (after `revokeKey`). The new plaintext is in this result only.
   */
  async rotateKey(ref: ConnectionRef): Promise<RotateKeyResult> {
    try {
      if (!validRef(ref)) return NOT_FOUND;
      const now = this.ports.clock.now();
      const minted = await this.mintKey(ref.connectionId, now);
      return await this.ports.store.transaction(async (tx): Promise<RotateKeyResult> => {
        const connection = await this.owned(tx, ref);
        if (!connection) return NOT_FOUND;
        if (connection.removedAt !== null) return DISCONNECTED;
        let revoked = 0;
        for (const key of await tx.listKeys(connection.id)) {
          if (key.revokedAt !== null) continue;
          await tx.putKey({ ...key, revokedAt: now });
          revoked += 1;
        }
        await tx.putKey(minted.record);
        return { ok: true, key: minted.issued, revoked };
      });
    } catch {
      return FAILED;
    }
  }

  /** Revokes one key. Revoking it again returns the same result. */
  async revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
    try {
      const keyId = (input as { keyId?: unknown } | null)?.keyId;
      if (!validRef(input) || typeof keyId !== "string" || !UUID_PATTERN.test(keyId)) return NOT_FOUND;
      return await this.ports.store.transaction(async (tx): Promise<RevokeKeyResult> => {
        const connection = await this.owned(tx, input);
        if (!connection) return NOT_FOUND;
        const key = (await tx.listKeys(connection.id)).find((candidate) => candidate.id === keyId && candidate.connectionId === connection.id);
        if (!key) return NOT_FOUND;
        if (key.revokedAt !== null) return { ok: true, key: keyView(key) };
        const revoked: KeyRecord = { ...key, revokedAt: this.ports.clock.now() };
        await tx.putKey(revoked);
        return { ok: true, key: keyView(revoked) };
      });
    } catch {
      return FAILED;
    }
  }

  /**
   * Changes the mode, the site URL or the URL shape. The handle never changes. Published versions are
   * not touched: a new URL shape gives a new `canonicalUrl` from the next "更新を公開".
   */
  async updateConnection(input: UpdateConnectionInput): Promise<UpdateConnectionResult> {
    try {
      if (!validRef(input)) return NOT_FOUND;
      const { handle, mode, siteUrl, urlShape } = input as Partial<Record<"handle" | "mode" | "siteUrl" | "urlShape", unknown>>;
      if (mode !== undefined && !isConnectionMode(mode)) return INVALID_MODE;
      if (siteUrl !== undefined && !isSiteUrl(siteUrl)) return INVALID_SITE_URL;
      if (urlShape !== undefined && !isUrlShape(urlShape)) return INVALID_URL_SHAPE;
      return await this.ports.store.transaction(async (tx): Promise<UpdateConnectionResult> => {
        const connection = await this.owned(tx, input);
        if (!connection) return NOT_FOUND;
        if (handle !== undefined && handle !== connection.handle) return HANDLE_LOCKED;
        if (connection.removedAt !== null) return DISCONNECTED;
        const next: ConnectionRecord = {
          ...connection,
          mode: mode ?? connection.mode,
          siteUrl: siteUrl ?? connection.siteUrl,
          urlShape: urlShape === undefined ? connection.urlShape : { host: urlShape.host, path: urlShape.path },
        };
        const changed = next.mode !== connection.mode || next.siteUrl !== connection.siteUrl
          || next.urlShape.host !== connection.urlShape.host || next.urlShape.path !== connection.urlShape.path;
        if (changed) await tx.putConnection(next);
        return { ok: true, connection: connectionView(next, await tx.listKeys(connection.id)) };
      });
    } catch {
      return FAILED;
    }
  }

  /**
   * In one transaction: revokes every key, marks the connection removed and stops every live page on its
   * handle (versions stay; no redirect is made, as for any stop on a site). Calling it again changes
   * nothing and reports 0 / 0.
   */
  async disconnect(ref: ConnectionRef): Promise<DisconnectResult> {
    try {
      if (!validRef(ref)) return NOT_FOUND;
      return await this.ports.store.transaction(async (tx): Promise<DisconnectResult> => {
        const connection = await this.owned(tx, ref);
        if (!connection) return NOT_FOUND;
        const now = this.ports.clock.now();
        const keys: KeyRecord[] = [];
        let revokedKeys = 0;
        for (const key of await tx.listKeys(connection.id)) {
          if (key.revokedAt !== null) {
            keys.push(key);
            continue;
          }
          const revoked: KeyRecord = { ...key, revokedAt: now };
          await tx.putKey(revoked);
          keys.push(revoked);
          revokedKeys += 1;
        }
        let removed = connection;
        if (connection.removedAt === null) {
          removed = { ...connection, removedAt: now };
          await tx.putConnection(removed);
        }
        let stopped = 0;
        for (const publication of await tx.listPublicationsByHandle(connection.handle)) {
          if (publication.handle !== connection.handle || publication.stoppedAt !== null) continue;
          await tx.putPublication({ ...publication, stoppedAt: now });
          stopped += 1;
        }
        return { ok: true, connection: connectionView(removed, keys), revokedKeys, stopped };
      });
    } catch {
      return FAILED;
    }
  }

  /**
   * The pages published on the connection, stopped ones included, newest update first. Title and URL
   * are the published version's; "更新あり" compares the draft's fingerprint (from `drafts`).
   */
  async listPublished(ref: ConnectionRef): Promise<ListPublishedResult> {
    try {
      if (!validRef(ref)) return NOT_FOUND;
      const found = await this.ports.store.transaction(async (tx) => {
        const connection = await this.owned(tx, ref);
        return connection ? this.currentVersions(tx, connection) : null;
      });
      if (found === null) return NOT_FOUND;
      const items: PublishedOnConnection[] = [];
      for (const { publication, snapshot } of found) {
        const draft = await this.ports.drafts.read(publication.pageId);
        const view = { range: publication.range, stoppedAt: publication.stoppedAt, fingerprint: snapshot.fingerprint };
        // No draft (it cannot be compared): never claim "更新あり".
        const status = deriveStatus(view, typeof draft === "string" ? draft : snapshot.fingerprint) as Exclude<StatusState, "private">;
        items.push({
          pageId: publication.pageId,
          title: snapshot.title,
          url: snapshot.canonicalUrl,
          slug: publication.slug,
          status,
          version: publication.version,
          publishedAt: publication.publishedAt,
          updatedAt: publication.updatedAt,
          stoppedAt: publication.stoppedAt,
        });
      }
      items.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.pageId < b.pageId ? -1 : 1));
      return { ok: true, items };
    } catch {
      return FAILED;
    }
  }

  /**
   * Markdown + photos (zip) of the last published version of every page on the connection, stopped
   * ones included. The owner can export after disconnecting too.
   */
  async exportConnection(ref: ConnectionRef): Promise<ExportConnectionResult> {
    try {
      if (!validRef(ref)) return NOT_FOUND;
      const found = await this.ports.store.transaction(async (tx) => {
        const connection = await this.owned(tx, ref);
        return connection ? this.currentVersions(tx, connection) : null;
      });
      if (found === null) return NOT_FOUND;
      const docs: ExportDoc[] = found.map((entry) => entry.snapshot);
      const photos = new Map<string, Uint8Array>();
      const tried = new Set<string>();
      for (const doc of docs) {
        for (const asset of doc.assets) {
          if (tried.has(asset.sha256) || !SHA256_PATTERN.test(asset.sha256)) continue;
          tried.add(asset.sha256);
          const data = await this.ports.assetBytes.read({ id: asset.id, sha256: asset.sha256, contentType: asset.contentType });
          if (data instanceof Uint8Array) photos.set(asset.sha256, data);
        }
      }
      return await buildExportArchive({ docs, photos });
    } catch {
      return FAILED;
    }
  }

  /**
   * The connection a key belongs to, or `null`: malformed, unknown, revoked, or its connection removed
   * (not distinguished). Checked on every call; nothing is cached. Throws `AuthenticationUnavailable`
   * (no data) when the store cannot answer.
   */
  async authenticateKey(plaintext: unknown): Promise<AuthenticatedConnection | null> {
    if (!isConnectionKey(plaintext)) return null;
    try {
      const digest = await sha256Hex(plaintext);
      return await this.ports.store.transaction(async (tx): Promise<AuthenticatedConnection | null> => {
        const key = await tx.findKeyBySha256(digest);
        if (key === null || key.sha256 !== digest || key.revokedAt !== null) return null;
        const connection = await tx.getConnection(key.connectionId);
        if (connection === null || connection.id !== key.connectionId || connection.removedAt !== null || !isConnectionHandle(connection.handle)) {
          return null;
        }
        return { connectionId: connection.id, handle: connection.handle };
      });
    } catch {
      throw new AuthenticationUnavailable();
    }
  }

  // --- internals ---

  private async owned(tx: ConnectionTx, ref: ConnectionRef): Promise<ConnectionRecord | null> {
    const connection = await tx.getConnection(ref.connectionId);
    return connection !== null && connection.id === ref.connectionId && connection.ownerId === ref.actorId ? connection : null;
  }

  /** Each publication on the connection's handle with the version it currently shows. */
  private async currentVersions(
    tx: ConnectionTx,
    connection: ConnectionRecord,
  ): Promise<readonly { readonly publication: PublicationRecord; readonly snapshot: VersionRecord["snapshot"] }[]> {
    const out: { publication: PublicationRecord; snapshot: VersionRecord["snapshot"] }[] = [];
    for (const publication of await tx.listPublicationsByHandle(connection.handle)) {
      if (publication.handle !== connection.handle) continue;
      const version = await tx.getVersion(publication.pageId, publication.version);
      // A publication always points at a version on its own handle; anything else is a broken store.
      if (version === null || version.handle !== connection.handle) throw new Error("publication without its version");
      out.push({ publication, snapshot: version.snapshot });
    }
    return out;
  }

  private randomBytes(n: number): Uint8Array {
    const bytes = this.random.bytes(n);
    if (!(bytes instanceof Uint8Array) || bytes.length !== n) throw new Error("random source failed");
    return Uint8Array.from(bytes);
  }

  /** 256 random bits as `ek_` + 43 base64url characters; only the hash and the last 4 characters are kept. */
  private async mintKey(connectionId: string, now: string): Promise<{ readonly record: KeyRecord; readonly issued: IssuedKey }> {
    const plaintext = `${CONNECTION_KEY_PREFIX}${base64url(this.randomBytes(32))}`;
    if (!isConnectionKey(plaintext)) throw new Error("key generation failed");
    const sha256 = await sha256Hex(plaintext);
    const last4 = plaintext.slice(-4);
    const id = uuidFrom(this.randomBytes(16));
    return {
      record: { id, connectionId, sha256, last4, createdAt: now, revokedAt: null },
      issued: { id, plaintext, masked: maskedOf(last4), createdAt: now },
    };
  }
}
