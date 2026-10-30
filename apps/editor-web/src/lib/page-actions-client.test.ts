import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PageActionError,
  duplicatePageRequest,
  getPageShare,
  pageExportUrl,
  rotatePageShare,
  startPageShare,
  stopPageShare,
} from "./page-actions-client";

const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const PUBLIC = { status: "PUBLIC", publicId: "p".repeat(22), url: `https://editor.test/s/${"t".repeat(43)}`, updatedAt: "2026-01-01T00:00:00.000Z" };
const PRIVATE = { status: "PRIVATE", publicId: null, url: null, updatedAt: null };

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page actions client", () => {
  it("calls the share endpoints with the right method and same-origin, uncached requests", async () => {
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => getPageShare(ID), "GET", `/api/pages/${ID}/share`, PRIVATE],
      [() => startPageShare(ID), "PUT", `/api/pages/${ID}/share`, PUBLIC],
      [() => rotatePageShare(ID), "POST", `/api/pages/${ID}/share/rotate`, PUBLIC],
      [() => stopPageShare(ID), "DELETE", `/api/pages/${ID}/share`, PRIVATE],
    ];
    for (const [run, method, path, share] of cases) {
      const fetchMock = mockFetch(200, { share: { ...(share as object), extra: "dropped" } });
      expect(await run()).toEqual(share);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(path, { method, credentials: "same-origin", cache: "no-store" });
    }
  });

  it("encodes the page id into the path", async () => {
    const fetchMock = mockFetch(404, { error: "not_found" });
    await expect(getPageShare("../search?q=x")).rejects.toThrow(PageActionError);
    expect(fetchMock).toHaveBeenCalledWith("/api/pages/..%2Fsearch%3Fq%3Dx/share", expect.anything());
    expect(pageExportUrl("a/b")).toBe("/api/pages/a%2Fb/export.md");
    expect(pageExportUrl(ID)).toBe(`/api/pages/${ID}/export.md`);
  });

  it("throws PageActionError with the status on an error response", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      mockFetch(status, { error: "x" });
      await expect(startPageShare(ID)).rejects.toMatchObject({ name: "PageActionError", status });
    }
  });

  it("refuses a malformed share state", async () => {
    for (const share of [undefined, null, { status: "OPEN", publicId: null, url: null, updatedAt: null }, { status: "PUBLIC", publicId: 1, url: null, updatedAt: null }, { status: "PRIVATE", publicId: "x", url: "https://x/s/y", updatedAt: null }]) {
      mockFetch(200, { share });
      await expect(getPageShare(ID)).rejects.toMatchObject({ status: 500 });
    }
  });

  it("duplicates a page and returns the new id", async () => {
    const newId = "7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d12";
    const fetchMock = mockFetch(201, { page: { id: newId, title: "合成のコピー" } });
    expect(await duplicatePageRequest(ID)).toBe(newId);
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/duplicate`, { method: "POST", credentials: "same-origin", cache: "no-store" });
    mockFetch(201, { page: { id: "not-a-uuid" } });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 500 });
    mockFetch(404, { error: "not_found" });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 404 });
  });
});
