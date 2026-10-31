// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_DESTINATIONS_TEXT } from "niho-docs-ui/shell";
import type { DestinationsFailure, IssuedKeyDto, SiteDestinationDto, SiteDetailDto } from "@/lib/destinations-client";
import { DESTINATION_MESSAGES } from "@/publish/messages";

const push = vi.fn();
const loadSite = vi.fn<() => Promise<{ ok: true; value: SiteDetailDto } | DestinationsFailure>>();
const updateSite = vi.fn<(id: string, patch: unknown) => Promise<{ ok: true; value: SiteDestinationDto } | DestinationsFailure>>();
const rotateSiteKey = vi.fn<() => Promise<{ ok: true; value: { key: IssuedKeyDto; site: SiteDestinationDto } } | DestinationsFailure>>();
const disconnectSite = vi.fn<() => Promise<{ ok: true; value: { stopped: number; revokedKeys: number } } | DestinationsFailure>>();
const writeText = vi.fn<(value: string) => Promise<void>>();
const assign = vi.fn<(url: string) => void>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/destinations-client", () => ({
  loadSite: () => loadSite(),
  updateSite: (id: string, patch: unknown) => updateSite(id, patch),
  rotateSiteKey: () => rotateSiteKey(),
  disconnectSite: () => disconnectSite(),
  exportPath: (id: string) => `/api/destinations/${id}/export`,
}));

import { SiteView } from "./SiteView";

// 合成の値だけを使う（鍵の形だけが要るところは、鍵でない文字列を使う）
const OLD_MASKED = "ek_••••••••1111";
const NEW_MASKED = "ek_••••••••3f9a";
const NEW_PLAINTEXT = "ek_synthetic-plaintext-key-value-not-a-real-key";
const SITE_ID = "11111111-2222-4333-8444-555555555555";

function siteOf(patch: Partial<SiteDestinationDto> = {}): SiteDestinationDto {
  return {
    id: SITE_ID,
    handle: "mika-sato",
    mode: "api",
    siteUrl: "https://mika-sato.example",
    urlShape: { host: "mika-sato.example", path: "posts" },
    articleUrl: "https://mika-sato.example/posts/{slug}",
    apiUrl: "https://api.editor.niho.life/v1/mika-sato/published.json",
    assetPolicy: "copy-on-import",
    pushEnabled: false,
    createdAt: "2026-10-30T00:00:00.000Z",
    removedAt: null,
    keys: [{ id: "k1", masked: OLD_MASKED, createdAt: "2026-10-30T00:00:00.000Z", revokedAt: null, active: true }],
    published: 1,
    ...patch,
  };
}

function detail(patch: Partial<SiteDetailDto> = {}): SiteDetailDto {
  return {
    site: siteOf(),
    published: [
      {
        pageId: "11111111-2222-4333-8444-aaaaaaaaaaaa",
        title: "Kamakura morning walk",
        url: "https://mika-sato.example/posts/kamakura-morning-walk",
        slug: "kamakura-morning-walk",
        status: "published",
        version: 1,
        publishedAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
        stoppedAt: null,
      },
    ],
    ...patch,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of [push, loadSite, updateSite, rotateSiteKey, disconnectSite, writeText, assign]) mock.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(window, "location", { value: { assign, search: "", hash: "" }, configurable: true });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(initial: SiteDetailDto = detail()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SiteView id={SITE_ID} initial={initial} />);
  });
  return container;
}

const buttons = () => [...(container?.querySelectorAll("button") ?? [])];
const button = (label: string) => buttons().find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);
const click = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no button named ${label}`);
  await act(async () => target.click());
};
const inputs = () => [...(container?.querySelectorAll<HTMLInputElement>("input") ?? [])];
const type = async (label: string, value: string) => {
  const node = [...(container?.querySelectorAll("label") ?? [])].find((item) => item.textContent === label);
  const input = node ? inputs().find((item) => item.id === node.htmlFor) : undefined;
  if (!input) throw new Error(`no field named ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const status = () => container?.querySelector('[role="status"]')?.textContent;

describe("SiteView", () => {
  it("shows the 公開API URL, the masked key and the published pages", async () => {
    const text = (await mount()).textContent ?? "";
    expect(text).toContain("https://api.editor.niho.life/v1/mika-sato/published.json");
    expect(text).toContain(OLD_MASKED);
    expect(text).toContain("Kamakura morning walk");
    expect(text).not.toContain(NEW_PLAINTEXT);
  });

  it("copies the 公開API URL", async () => {
    await mount();
    await click("公開APIの URL をコピー");
    expect(writeText).toHaveBeenCalledWith("https://api.editor.niho.life/v1/mika-sato/published.json");
    expect(status()).toContain("コピーしました");
  });

  it("asks before re-issuing the key, and shows the new one once", async () => {
    await mount();
    rotateSiteKey.mockResolvedValue({
      ok: true,
      value: { key: { id: "k2", masked: NEW_MASKED, plaintext: NEW_PLAINTEXT, createdAt: "2026-10-31T00:00:00.000Z" }, site: siteOf() },
    });
    loadSite.mockResolvedValue({
      ok: true,
      value: detail({
        site: siteOf({
          keys: [
            { id: "k2", masked: NEW_MASKED, createdAt: "2026-10-31T00:00:00.000Z", revokedAt: null, active: true },
            { id: "k1", masked: OLD_MASKED, createdAt: "2026-10-30T00:00:00.000Z", revokedAt: "2026-10-31T00:00:00.000Z", active: false },
          ],
        }),
      }),
    });
    await click("鍵を再発行");
    expect(rotateSiteKey).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(EDITOR_DESTINATIONS_TEXT.keyConfirm);
    await click("鍵を再発行する");
    expect(rotateSiteKey).toHaveBeenCalledTimes(1);
    expect(status()).toBe(DESTINATION_MESSAGES.keyRotated);
    expect(container?.textContent).toContain(NEW_PLAINTEXT);
    // 読み直した設定では、新しい鍵が有効で旧鍵は失効した印
    expect(container?.textContent).toContain(NEW_MASKED);
    expect(container?.textContent).toContain("失効した鍵 1");
    await click("新しい鍵を閉じる");
    expect(container?.textContent).not.toContain(NEW_PLAINTEXT);
  });

  it("does nothing when the re-issue is cancelled", async () => {
    await mount();
    await click("鍵を再発行");
    await click("鍵の再発行をやめる");
    expect(rotateSiteKey).not.toHaveBeenCalled();
    expect(button("鍵を再発行")).toBeTruthy();
  });

  it("says the server's reason when the re-issue fails, and shows no key", async () => {
    await mount();
    rotateSiteKey.mockResolvedValue({ ok: false, status: 409, error: "disconnected", message: DESTINATION_MESSAGES.disconnected });
    await click("鍵を再発行");
    await click("鍵を再発行する");
    expect(status()).toBe(DESTINATION_MESSAGES.disconnected);
    expect(container?.textContent).not.toContain(NEW_PLAINTEXT);
  });

  it("saves the URL shape with the path trimmed of slashes", async () => {
    await mount();
    updateSite.mockResolvedValue({ ok: true, value: siteOf({ urlShape: { host: "mika-sato.example", path: "journal" }, articleUrl: "https://mika-sato.example/journal/{slug}" }) });
    await click("URL の形を編集");
    await type("記事の前に付く path（空でもよい）", "/journal/");
    await click("URL の形を保存");
    expect(updateSite).toHaveBeenCalledWith(SITE_ID, { urlShape: { host: "mika-sato.example", path: "journal" } });
    expect(container?.textContent).toContain("https://mika-sato.example/journal/{slug}");
  });

  it("saves the 送り方 and says that WordPress cannot push yet", async () => {
    await mount();
    updateSite.mockResolvedValue({ ok: true, value: siteOf({ mode: "wordpress" }) });
    await click("WordPress");
    expect(updateSite).toHaveBeenCalledWith(SITE_ID, { mode: "wordpress" });
    expect(status()).toBe(DESTINATION_MESSAGES.pushLater);
  });

  it("opens the export with no key in the URL", async () => {
    await mount();
    await click("Markdown + 写真（zip）");
    expect(assign).toHaveBeenCalledWith(`/api/destinations/${SITE_ID}/export`);
    expect(assign.mock.calls[0]?.[0]).not.toContain("ek_");
  });

  it("asks before disconnecting, says what it costs, and goes back to the list", async () => {
    await mount();
    disconnectSite.mockResolvedValue({ ok: true, value: { stopped: 1, revokedKeys: 1 } });
    await click("接続を解除");
    expect(disconnectSite).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(EDITOR_DESTINATIONS_TEXT.disconnectConfirm);
    await click("接続の解除をやめる");
    expect(disconnectSite).not.toHaveBeenCalled();
    await click("接続を解除");
    await click("接続を解除する");
    expect(disconnectSite).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/destinations");
  });

  it("stays on the page and says the reason when disconnecting fails", async () => {
    await mount();
    disconnectSite.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: DESTINATION_MESSAGES.unavailable });
    await click("接続を解除");
    await click("接続を解除する");
    expect(push).not.toHaveBeenCalled();
    expect(status()).toBe(DESTINATION_MESSAGES.unavailable);
  });
});
