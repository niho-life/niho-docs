/**
 * ブラウザから `/api/destinations/**` を呼ぶ（同じ origin）。
 * 平文の鍵は、作ったとき・再発行したときの応答にだけ入る。受け取った平文は画面の state に 1 回だけ置き、
 * URL・localStorage・ログには出さない（この module も保存しない）。
 */

import { DESTINATION_MESSAGES } from "@/publish/messages";
import type { DestinationsDto, IssuedKeyDto, SiteDestinationDto, SiteDetailDto } from "@/server/connections-api";

export type { DestinationsDto, IssuedKeyDto, SiteDestinationDto, SiteDetailDto };

export type DestinationsFailure = { ok: false; status: number; error: string | null; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathOf(id: string, suffix = ""): string {
  if (!UUID_PATTERN.test(id)) throw new Error("invalid connection id");
  return `/api/destinations/${id}${suffix}`;
}

function fallback(status: number): string {
  if (status === 401) return DESTINATION_MESSAGES.signedOut;
  if (status === 403) return DESTINATION_MESSAGES.forbidden;
  if (status === 404) return DESTINATION_MESSAGES.notFound;
  if (status === 503) return DESTINATION_MESSAGES.unavailable;
  return DESTINATION_MESSAGES.failed;
}

/** 応答の message（サーバーが決めた一言）を使い、無ければ status から決める。 */
async function failureOf(response: Response): Promise<DestinationsFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  return {
    ok: false,
    status: response.status,
    error: typeof body?.error === "string" ? body.error : null,
    message: typeof body?.message === "string" ? body.message : fallback(response.status),
  };
}

const NETWORK: DestinationsFailure = { ok: false, status: 0, error: null, message: DESTINATION_MESSAGES.network };

async function send<T>(path: string, init: RequestInit, pick: (body: unknown) => T | null): Promise<{ ok: true; value: T } | DestinationsFailure> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response);
  const body = (await response.json().catch(() => null)) as unknown;
  const value = pick(body);
  return value === null ? { ...NETWORK, message: DESTINATION_MESSAGES.failed } : { ok: true, value };
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function field<T>(body: unknown, key: string): T | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null ? (value as T) : null;
}

export function loadDestinations(): Promise<{ ok: true; value: DestinationsDto } | DestinationsFailure> {
  return send("/api/destinations", { method: "GET" }, (body) => field<DestinationsDto>(body, "destinations"));
}

export type CreateSiteInput = { handle: string; mode: "api" | "wordpress" | "ghost"; siteUrl: string; urlShape?: { host: string; path: string } };

/** 接続を作る。応答の `key.plaintext` は 1 回だけ（保存しない）。 */
export function createSite(input: CreateSiteInput): Promise<{ ok: true; value: { site: SiteDestinationDto; key: IssuedKeyDto } } | DestinationsFailure> {
  return send("/api/destinations", json(input), (body) => {
    const site = field<SiteDestinationDto>(body, "site");
    const key = field<IssuedKeyDto>(body, "key");
    return site && key ? { site, key } : null;
  });
}

export function loadSite(id: string): Promise<{ ok: true; value: SiteDetailDto } | DestinationsFailure> {
  return send(pathOf(id), { method: "GET" }, (body) => {
    const site = field<SiteDestinationDto>(body, "site");
    const published = (body as { published?: unknown } | null)?.published;
    return site && Array.isArray(published) ? ({ site, published } as SiteDetailDto) : null;
  });
}

export function updateSite(id: string, patch: { siteUrl?: string; urlShape?: { host: string; path: string }; mode?: CreateSiteInput["mode"] }) {
  return send(pathOf(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }, (body) =>
    field<SiteDestinationDto>(body, "site"),
  );
}

/** 鍵を再発行する。応答の `key.plaintext` は 1 回だけ（保存しない）。 */
export function rotateSiteKey(id: string): Promise<{ ok: true; value: { key: IssuedKeyDto; site: SiteDestinationDto } } | DestinationsFailure> {
  return send(pathOf(id, "/key"), json({}), (body) => {
    const key = field<IssuedKeyDto>(body, "key");
    const site = field<SiteDestinationDto>(body, "site");
    return key && site ? { key, site } : null;
  });
}

export function disconnectSite(id: string): Promise<{ ok: true; value: { stopped: number; revokedKeys: number } } | DestinationsFailure> {
  return send(pathOf(id, "/disconnect"), json({}), (body) => {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    return record && typeof record.stopped === "number" && typeof record.revokedKeys === "number"
      ? { stopped: record.stopped, revokedKeys: record.revokedKeys }
      : null;
  });
}

/** 書き出しの URL（ブラウザにそのまま開かせる。鍵は入らない）。 */
export function exportPath(id: string): string {
  return pathOf(id, "/export");
}
