import { resolveStorageConfig, type StorageEnv } from "../storage/config";
import { FAKE_STORAGE_MAX_BYTES, FAKE_TOKEN_PATTERN, type FakeStorage } from "../storage/fake";
import { errorResponse, jsonResponse, notFoundResponse } from "./http";

/**
 * 偽の保存先の受け口（開発と CI だけ）。ブラウザが GCS のセッション URI へ PUT する代わりに、ticket の url
 * （`/api/dev/fake-storage/{token}`）への PUT を受けて偽の保存先に置く。
 *
 * `EDITOR_STORAGE` が fake（未設定の非本番を含む）で、かつ `NODE_ENV` が production でないときだけ動き、それ以外は常に 404
 * （本番では fake が起動しないことと二重の守り）。認証は見ない（GCS のセッション URI と同じく、token を持つ人だけが置ける）。
 */

export type FakeStorageRouteDeps = {
  env: StorageEnv;
  storage: () => FakeStorage;
};

/** 偽の受け口が動く設定か。 */
export function fakeStorageEnabled(env: StorageEnv): boolean {
  if (env.NODE_ENV === "production") return false;
  try {
    return resolveStorageConfig(env).kind === "fake";
  } catch {
    return false;
  }
}

async function readBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** PUT /api/dev/fake-storage/{token} — 置いたら 200、token が無い・期限切れは 404、既にある（上書きしない）は 412、大きすぎるは 413。 */
export async function fakeStoragePutRoute(request: Request, token: string, deps: FakeStorageRouteDeps): Promise<Response> {
  if (!fakeStorageEnabled(deps.env)) return notFoundResponse();
  if (!FAKE_TOKEN_PATTERN.test(token)) return notFoundResponse();
  const bytes = await readBytes(request, FAKE_STORAGE_MAX_BYTES);
  if (!bytes) return errorResponse("payload_too_large");
  const result = deps.storage().putFakeObject(token, bytes, request.headers.get("content-type"));
  if (result === "ok") return jsonResponse(200, { size: String(bytes.byteLength) });
  if (result === "exists") return jsonResponse(412, { error: "precondition_failed" });
  if (result === "too_large") return errorResponse("payload_too_large");
  return notFoundResponse();
}
