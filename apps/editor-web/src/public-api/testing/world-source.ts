/**
 * テスト専用：契約の合成の world（@niho/editor-publish-contract/test-support の ReferenceWorld）を PublicApiSource にする。
 * 本番では使わない。段 2 の Postgres の実装は、この実装と同じ答えを返す（handler.test.ts が参照モデルと突き合わせる）。
 *
 * 時刻の扱いは参照モデルと同じ：失効・解除・公開をやめた時刻は `<= now` で効く（未来の時刻はまだ効いていない）。
 */

import { destOfHandle, isConnectionHandle, isFaceDest, type FaceDest } from "@niho/editor-publish-contract";
import type { ReferenceWorld, WorldPublication } from "@niho/editor-publish-contract/test-support";
import type { FaceCredentialSource, PublicApiSource, PublishedLookup, PublishedRow } from "../source";

const time = (iso: string): number => Date.parse(iso);

export interface WorldSourceOptions {
  /** 呼ばれた問い合わせの名前を記録する（引数は記録しない）。 */
  readonly calls?: string[];
}

export function worldSource(world: ReferenceWorld, options: WorldSourceOptions = {}): PublicApiSource {
  const record = (name: string) => options.calls?.push(name);
  const isActive = (revokedAt: string | null, now: string): boolean => revokedAt === null || time(revokedAt) > time(now);
  const isStopped = (publication: WorldPublication, now: string): boolean =>
    publication.stoppedAt !== null && time(publication.stoppedAt) <= time(now);
  const row = (publication: WorldPublication): PublishedRow => ({ range: publication.range, snapshot: publication.snapshot });

  return {
    async siteHandleByKeyHash(sha256, now) {
      record("siteHandleByKeyHash");
      for (const connection of world.connections) {
        if (!isActive(connection.removedAt, now) || !isConnectionHandle(connection.handle)) continue;
        if (connection.keys.some((key) => key.sha256 === sha256 && isActive(key.revokedAt, now))) return connection.handle;
      }
      return null;
    },

    async listPublished({ handle, includeUnlisted, after, limit, now }) {
      record("listPublished");
      const dest = destOfHandle(handle);
      return world.publications
        .filter((publication) =>
          publication.handle === handle && publication.snapshot.dest === dest && !isStopped(publication, now)
          && (publication.range === "live" || (includeUnlisted && publication.range === "unlisted")))
        .sort((a, b) =>
          time(b.snapshot.updatedAt) - time(a.snapshot.updatedAt) || (a.snapshot.id < b.snapshot.id ? -1 : a.snapshot.id > b.snapshot.id ? 1 : 0))
        .filter((publication) => {
          if (!after) return true;
          const at = time(publication.snapshot.updatedAt);
          return at < time(after.updatedAt) || (at === time(after.updatedAt) && publication.snapshot.id > after.id);
        })
        .slice(0, limit)
        .map(row);
    },

    async getPublished(handle, pageId, now): Promise<PublishedLookup> {
      record("getPublished");
      const dest = destOfHandle(handle);
      const candidates = world.publications.filter((publication) =>
        publication.pageId === pageId && publication.handle === handle && publication.snapshot.dest === dest);
      const publication = candidates.find((candidate) => !isStopped(candidate, now)) ?? candidates[0];
      if (!publication) return { state: "none" };
      if (!isStopped(publication, now)) return { state: "published", row: row(publication) };
      // 面 → 別の面の移動で、移動先にいま公開中のときだけ移動先を答える
      const target = publication.movedToHandle;
      let movedTo = null;
      if (isFaceDest(publication.handle) && isFaceDest(target) && target !== publication.handle) {
        const next = world.publications.find((candidate) =>
          candidate.pageId === publication.pageId && candidate.handle === target
          && candidate.snapshot.dest === target && !isStopped(candidate, now));
        if (next) movedTo = { dest: target, canonicalUrl: next.snapshot.canonicalUrl };
      }
      return { state: "left", range: publication.range, movedTo };
    },

    async previewTokenByHash(sha256) {
      record("previewTokenByHash");
      const token = world.previewTokens.find((candidate) => candidate.sha256 === sha256);
      return token ? { pageId: token.pageId, handle: token.handle, issuedAt: token.issuedAt, expiresAt: token.expiresAt } : null;
    },

    async previewDraft(pageId) {
      record("previewDraft");
      const page = world.pages.find((candidate) => candidate.id === pageId);
      return page ? { revision: page.draft.revision, savedAt: page.draft.savedAt, content: page.draft.content } : null;
    },
  };
}

/** world の面の資格（失効・期限は参照モデルと同じ）。本番は EDITOR_FACE_CREDENTIALS（source.ts の faceCredentialsFromEnv）。 */
export function worldFaces(world: ReferenceWorld): FaceCredentialSource {
  return {
    audienceByHash(sha256, now): FaceDest | null {
      const face = world.faceCredentials.find((candidate) => candidate.sha256 === sha256);
      if (!face) return null;
      const active = face.revokedAt === null || time(face.revokedAt) > time(now);
      return active && time(face.expiresAt) > time(now) ? face.audience : null;
    },
  };
}
