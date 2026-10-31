/**
 * テスト専用：差分の性質テストの合成の world と要求（乱数の種から決定的に作る）。
 * 資格（正しい鍵・失効・旧鍵・解除した接続・未来に失効する鍵・面の token・期限切れ・別の面）、公開の状態（公開中・限定公開・
 * 公開をやめた・未来に公開をやめる・面と本人のサイトの間の移動・移動先も公開をやめた・dest の食い違い・契約に合わない公開版）、
 * プレビュー token（有効・期限切れ・ちょうど今切れる・15 分を超える・ちょうど 15 分・ページが無い・読めない handle）を混ぜる。
 * 失効・解除・公開をやめた時刻・期限には、ちょうど now（効いている側の境目）も混ぜる。
 */

import { destOfHandle, type Dest, type FaceDest, type PublicationRange, type PublishedAsset } from "@niho/editor-publish-contract";
import {
  hashCredential,
  type ReferenceWorld,
  type WorldConnection,
  type WorldFaceCredential,
  type WorldPage,
  type WorldPreviewToken,
  type WorldPublication,
} from "@niho/editor-publish-contract/test-support";
import {
  createRng,
  draftContent,
  minutesFrom,
  paragraphs,
  snapshot,
  syntheticKey,
  syntheticPreviewToken,
  syntheticServiceToken,
  syntheticUuid,
  type Rng,
} from "./synthetic";

export const RANDOM_NOW = "2026-10-01T00:00:00.000Z";

export interface RandomCredential {
  readonly value: string;
  /** その資格で読めるはずの handle（読めない資格は、それらしい handle）。 */
  readonly reads: string;
  readonly kind: "site" | "face";
  readonly valid: boolean;
}

export interface RandomWorld {
  readonly world: ReferenceWorld;
  readonly handles: readonly string[];
  readonly credentials: readonly RandomCredential[];
  readonly pageIds: readonly string[];
  readonly previewTokens: readonly string[];
  readonly secrets: readonly string[];
}

const RECORDING: PublishedAsset = {
  id: "asset-recording-01",
  url: "https://assets.example.com/a/recording-01.m4a",
  contentType: "audio/mp4" as PublishedAsset["contentType"],
  bytes: 4096,
  sha256: "2".repeat(64),
  alt: "",
  credit: null,
};

/** 効いている時刻（ちょうど now も含む。`<= now` の境目）。 */
const past = (rng: Rng): string => (rng.chance(0.1) ? RANDOM_NOW : minutesFrom(RANDOM_NOW, -(1 + rng.int(20_000))));
const future = (rng: Rng): string => minutesFrom(RANDOM_NOW, 1 + rng.int(20_000));
/** 同じ時刻が重なるよう、少ない候補から選ぶ（同時刻は id の昇順の確認）。 */
const updatedAt = (rng: Rng): string => minutesFrom("2026-09-01T00:00:00.000Z", rng.int(6) * 60);

function destOf(handle: string): Dest {
  return destOfHandle(handle) ?? "site";
}

export async function generateWorld(seed: number): Promise<RandomWorld> {
  const rng = createRng(seed);
  const credentials: RandomCredential[] = [];
  const connections: WorldConnection[] = [];
  const siteHandles = Array.from({ length: 1 + rng.int(3) }, (_, index) => `s${seed}-${index}`);
  for (const handle of siteHandles) {
    const state = rng.pick(["active", "active", "active", "removed", "removing-later"] as const);
    const removedAt = state === "removed" ? past(rng) : state === "removing-later" ? future(rng) : null;
    const keys = [];
    for (let index = 0; index < 1 + rng.int(3); index += 1) {
      const value = syntheticKey(rng);
      const keyState = rng.pick(["active", "revoked", "superseded", "revoking-later"] as const);
      const revokedAt = keyState === "active" ? null : keyState === "revoking-later" ? future(rng) : past(rng);
      keys.push({ sha256: await hashCredential(value), revokedAt });
      credentials.push({ value, reads: handle, kind: "site", valid: state !== "removed" && (keyState === "active" || keyState === "revoking-later") });
    }
    connections.push({ id: `connection-${handle}`, handle, ownerId: `owner-${handle}`, removedAt, keys });
  }
  const faceCredentials: WorldFaceCredential[] = [];
  for (const audience of ["exp", "niho"] as const satisfies readonly FaceDest[]) {
    for (let index = 0; index < 1 + rng.int(2); index += 1) {
      const value = syntheticServiceToken(rng);
      const state = rng.pick(["active", "active", "expired", "revoked", "revoking-later"] as const);
      faceCredentials.push({
        sha256: await hashCredential(value),
        audience,
        expiresAt: state === "expired" ? past(rng) : future(rng),
        revokedAt: state === "revoked" ? past(rng) : state === "revoking-later" ? future(rng) : null,
      });
      credentials.push({ value, reads: audience, kind: "face", valid: state === "active" || state === "revoking-later" });
    }
  }
  // 面の資格に、本人のサイトの鍵の形の値を置いても面にはならない（鍵の形なら接続だけを見る）
  if (rng.chance(0.3)) {
    const value = syntheticKey(rng);
    faceCredentials.push({ sha256: await hashCredential(value), audience: "exp", expiresAt: future(rng), revokedAt: null });
    credentials.push({ value, reads: "exp", kind: "face", valid: false });
  }
  // どこにも保存していない資格
  credentials.push({ value: syntheticKey(rng), reads: siteHandles[0] ?? "s0-0", kind: "site", valid: false });
  credentials.push({ value: syntheticServiceToken(rng), reads: "exp", kind: "face", valid: false });

  const handles = ["exp", "niho", ...siteHandles];
  const publications: WorldPublication[] = [];
  const pages: WorldPage[] = [];
  const pageIds: string[] = [];
  for (let index = 0; index < 3 + rng.int(12); index += 1) {
    const id = syntheticUuid(rng);
    const slug = `page-${seed}-${index}`;
    pageIds.push(id);
    const draft = rng.chance(0.1)
      ? { ...draftContent(slug), assets: [RECORDING] } // 契約に合わない下書き（プレビューは 503）
      : rng.chance(0.2)
        ? { ...draftContent(slug), blocks: paragraphs(`DRAFT-ONLY edited ${index}`) }
        : draftContent(slug);
    if (rng.chance(0.9)) pages.push({ id, ownerId: "owner", draft: { revision: 1 + rng.int(5), savedAt: past(rng), content: draft } });
    const status = rng.pick(["draft", "private", "live", "live", "unlisted", "stopped", "stopping-later", "moved", "moved-target-stopped", "broken", "dest-mismatch"] as const);
    if (status === "draft" || status === "private") continue;
    const handle = rng.pick(handles);
    const dest = destOf(handle);
    const range: PublicationRange = status === "unlisted" && (dest !== "site" || rng.chance(0.2)) ? "unlisted" : "live";
    let published = snapshot({ id, dest, slug, title: `Published ${slug}`, updatedAt: updatedAt(rng) });
    if (status === "broken") published = { ...published, assets: [RECORDING] };
    if (status === "dest-mismatch") published = { ...published, dest: dest === "exp" ? "niho" : "exp" };
    const base = { pageId: id, handle, range, movedToHandle: null, snapshot: published };
    if (status === "stopped") {
      publications.push({ ...base, stoppedAt: past(rng) });
    } else if (status === "stopping-later") {
      publications.push({ ...base, stoppedAt: future(rng) });
    } else if (status === "moved" || status === "moved-target-stopped") {
      const target = rng.pick(handles.filter((candidate) => candidate !== handle));
      const targetDest = destOf(target);
      publications.push({ ...base, stoppedAt: past(rng), movedToHandle: target });
      publications.push({
        ...base,
        handle: target,
        range: "live",
        stoppedAt: status === "moved-target-stopped" ? past(rng) : null,
        snapshot: snapshot({
          id,
          dest: targetDest,
          slug,
          title: `Published ${slug}`,
          updatedAt: RANDOM_NOW,
          // 移動先の canonicalUrl が契約に合わなければ movedTo を付けない
          ...(rng.chance(0.1) ? { canonicalUrl: "http://insecure.example.com/x" } : {}),
        }),
      });
    } else {
      publications.push({ ...base, stoppedAt: null });
    }
  }

  const previewTokens: WorldPreviewToken[] = [];
  const previewValues: string[] = [];
  for (let index = 0; index < rng.int(5); index += 1) {
    const value = syntheticPreviewToken(rng);
    previewValues.push(value);
    if (rng.chance(0.1)) continue; // 発行していない token
    const kind = rng.pick(["valid", "valid", "valid", "expired", "expires-now", "long-lived", "exact-ttl", "missing-page", "bad-handle"] as const);
    const issuedAt = kind === "expired" ? minutesFrom(RANDOM_NOW, -20) : kind === "expires-now" ? minutesFrom(RANDOM_NOW, -15) : minutesFrom(RANDOM_NOW, -5);
    const expiresAt = kind === "expired" ? minutesFrom(RANDOM_NOW, -5)
      : kind === "expires-now" ? RANDOM_NOW
      : kind === "long-lived" ? minutesFrom(RANDOM_NOW, 11)
        : kind === "exact-ttl" ? minutesFrom(RANDOM_NOW, 10)
          : minutesFrom(RANDOM_NOW, 1 + rng.int(9));
    previewTokens.push({
      sha256: await hashCredential(value),
      pageId: kind === "missing-page" ? syntheticUuid(rng) : rng.pick(pageIds),
      handle: kind === "bad-handle" ? "Bad_Handle" : rng.pick(handles),
      issuedAt,
      expiresAt,
    });
  }

  return {
    world: { now: RANDOM_NOW, pages, publications, connections, faceCredentials, previewTokens },
    handles,
    credentials,
    pageIds,
    previewTokens: previewValues,
    secrets: [...credentials.map((credential) => credential.value), ...previewValues],
  };
}

export interface RandomRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** If-None-Match に、それぞれの server がその要求に返す今の ETag を入れる（"current" / "weak-current" / "list-current"）。 */
  readonly ifNoneMatch: "none" | "star" | "stale" | "malformed" | "current" | "weak-current" | "list-current";
  readonly kind: "list" | "doc" | "preview" | "other";
}

const UPPER_UUID = (id: string): string => id.toUpperCase();

export function randomRequest(rng: Rng, generated: RandomWorld): RandomRequest {
  const { handles, credentials, pageIds, previewTokens } = generated;
  const method = rng.chance(0.85) ? "GET" : rng.chance(0.6) ? "HEAD" : rng.pick(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
  // 7 割は有効なはずの資格（認可・存在・形の分岐に届くように）、残りは全ての資格から
  const valid = credentials.filter((candidate) => candidate.valid);
  const credential = valid.length > 0 && rng.chance(0.7) ? rng.pick(valid) : rng.pick(credentials);
  const headers: Record<string, string | readonly string[]> = {};
  const auth = rng.next();
  if (auth < 0.85) headers.authorization = `Bearer ${credential.value}`;
  else if (auth < 0.88) headers.Authorization = `bearer ${credential.value}`;
  else if (auth < 0.91) headers.authorization = `Basic ${credential.value}`;
  else if (auth < 0.94) headers.authorization = [`Bearer ${credential.value}`, `Bearer ${rng.pick(credentials).value}`];
  else if (auth < 0.96 && previewTokens.length > 0) headers.authorization = `Bearer ${rng.pick(previewTokens)}`;
  // 残りは Authorization なし

  const handle = rng.chance(0.7) ? credential.reads : rng.pick([...handles, "admin", "Site_Alpha", "preview", "v1"]);
  const id = rng.chance(0.85) ? rng.pick(pageIds) : rng.pick(["not-a-uuid", UPPER_UUID(rng.pick(pageIds)), "00000000-0000-4000-8000-000000000000"]);
  const extraQuery = rng.chance(0.08) ? rng.pick(["?x=1", "?", "?%zz=1"]) : "";
  let kind: RandomRequest["kind"];
  let url: string;
  const target = rng.next();
  if (target < 0.4) {
    kind = "list";
    const parts: string[] = [];
    if (rng.chance(0.4)) parts.push(`limit=${rng.pick(["1", "2", "3", "5", "50", "100", "0", "101", "050", "ten", "", "-1"])}`);
    if (rng.chance(0.3)) parts.push(`include=${rng.pick(["unlisted", "unlisted", "drafts", ""])}`);
    if (rng.chance(0.05)) parts.push("include=unlisted");
    if (rng.chance(0.05)) parts.push(rng.pick(["sort=asc", "cursor=not-a-cursor", "cursor=", "limit=2&limit=3", "%zz"]));
    url = `/v1/${handle}/published.json${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  } else if (target < 0.75) {
    kind = "doc";
    url = `/v1/${handle}/published/${id}.json${extraQuery}`;
  } else if (target < 0.9) {
    kind = "preview";
    const token = previewTokens.length > 0 && rng.chance(0.85) ? rng.pick(previewTokens) : rng.pick(["pv_short", "published", credential.value]);
    url = `/v1/preview/${token}.json${extraQuery}`;
  } else {
    kind = "other";
    url = rng.pick([
      `/v1/${handle}/drafts.json`,
      `/v1/${handle}/published.json/`,
      `/v1/${handle}/published/${id}`,
      "/v1/preview/published.json",
      `/v1//published.json`,
      `/v1/%65xp/published.json`,
      `/v2/${handle}/published.json`,
      `https://api.editor.niho.life/v1/${handle}/published.json`,
      `/v1/${handle}/published/${id}.json/extra`,
    ]);
  }
  const ifNoneMatch = rng.chance(0.6) ? "none" : rng.pick(["star", "stale", "malformed", "current", "current", "weak-current", "list-current"] as const);
  return { method, url, headers, ifNoneMatch, kind };
}
