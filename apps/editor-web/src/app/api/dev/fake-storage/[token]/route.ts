import { fakeStoragePutRoute } from "@/server/fake-storage-api";
import { getFakeStorage } from "@/storage/runtime";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

/** 偽の保存先の受け口（開発と CI だけ。EDITOR_STORAGE が fake で NODE_ENV が production でないときだけ動き、それ以外は 404）。 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const { token } = await context.params;
  return fakeStoragePutRoute(request, token, { env: process.env, storage: getFakeStorage });
}
