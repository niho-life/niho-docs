import { randomBytes } from "node:crypto";
import { StorageError, isObjectPath, type ObjectStorage, type StartUploadInput, type StoredObject, type UploadTicket } from "./types";

/**
 * メモリの中だけの偽の保存先（開発と CI だけ。本番では src/storage/config.ts が受け付けない）。
 * ticket の url は `/api/dev/fake-storage/{token}`（同じ origin の dev 用の受け口。src/app/api/dev/fake-storage/[token]/route.ts）で、
 * そこへの PUT が putFakeObject を呼ぶ。GCS と同じく、同じ場所に object が既にあれば上書きしない。
 * 偽物は PUT の大きさを申告と照らさない（完了の時の大きさの照合をサーバーの側で試せるように）。
 */

/** 偽の受け口の path の接頭辞。 */
export const FAKE_STORAGE_PATH = "/api/dev/fake-storage/";
/** 偽の受け口が受け取る本文の上限（偽物なので小さく）。 */
export const FAKE_STORAGE_MAX_BYTES = 64 * 1024 * 1024;
/** ticket の有効な時間。 */
export const FAKE_TICKET_TTL_MS = 60 * 60 * 1000;
/** token の形（32 バイトの乱数の base64url）。 */
export const FAKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type Session = { objectPath: string; contentType: string; sizeBytes: number; expiresAtMs: number };
type FakeObject = { bytes: Uint8Array; contentType: string | null };

export type FakeStorageState = { sessions: Map<string, Session>; objects: Map<string, FakeObject> };

/** ok: 置いた / not_found: token が無い・期限切れ / exists: 同じ場所に既にある / too_large: 上限を超える */
export type FakePutResult = "ok" | "not_found" | "exists" | "too_large";

export interface FakeStorage extends ObjectStorage {
  readonly kind: "fake";
  /** dev の受け口から: token のセッションの場所に object を置く。 */
  putFakeObject(token: string, bytes: Uint8Array, contentType: string | null): FakePutResult;
}

export function createFakeStorageState(): FakeStorageState {
  return { sessions: new Map(), objects: new Map() };
}

export function createFakeStorage(options: { state?: FakeStorageState; now?: () => number } = {}): FakeStorage {
  const state = options.state ?? createFakeStorageState();
  const now = options.now ?? Date.now;
  return {
    kind: "fake",
    async startUpload(input: StartUploadInput): Promise<UploadTicket> {
      if (!isObjectPath(input.objectPath) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new StorageError("rejected");
      // 既にある場所でもセッションは作れる（上書きは PUT の時に断る。GCS の ifGenerationMatch=0 の前提条件と同じ扱い）
      const token = randomBytes(32).toString("base64url");
      const expiresAtMs = now() + FAKE_TICKET_TTL_MS;
      state.sessions.set(token, { objectPath: input.objectPath, contentType: input.contentType, sizeBytes: input.sizeBytes, expiresAtMs });
      return {
        url: `${FAKE_STORAGE_PATH}${token}`,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    async stat(objectPath: string): Promise<StoredObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const object = state.objects.get(objectPath);
      return object ? { sizeBytes: object.bytes.byteLength, contentType: object.contentType } : null;
    },
    putFakeObject(token: string, bytes: Uint8Array, contentType: string | null): FakePutResult {
      if (!FAKE_TOKEN_PATTERN.test(token)) return "not_found";
      const session = state.sessions.get(token);
      if (!session || session.expiresAtMs <= now()) return "not_found";
      if (bytes.byteLength > FAKE_STORAGE_MAX_BYTES) return "too_large";
      if (state.objects.has(session.objectPath)) return "exists";
      state.objects.set(session.objectPath, { bytes: bytes.slice(), contentType: contentType ?? session.contentType });
      state.sessions.delete(token);
      return "ok";
    },
  };
}
