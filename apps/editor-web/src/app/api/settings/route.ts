import { getSettings, patchSettings } from "@/server/settings-api";
import { settingsDeps } from "@/server/settings-deps";

export const dynamic = "force-dynamic";

/** アカウントの設定（AI の提案の言語・固有名詞・手順）。 */
export function GET(request: Request): Promise<Response> {
  return getSettings(request, settingsDeps);
}

export function PATCH(request: Request): Promise<Response> {
  return patchSettings(request, settingsDeps);
}
