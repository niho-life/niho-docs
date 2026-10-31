import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PageActionError,
  deletePageRequest,
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

  it("duplicates a page and returns the new id, title and kind (for the top of the list)", async () => {
    const newId = "7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d12";
    const fetchMock = mockFetch(201, { page: { id: newId, title: "合成のコピー", kind: "rec", blocks: [] } });
    expect(await duplicatePageRequest(ID)).toEqual({ id: newId, title: "合成のコピー", kind: "rec" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/duplicate`, { method: "POST", credentials: "same-origin", cache: "no-store" });
    // 読めない種類は note として扱う（複製はできているので失敗にしない）
    mockFetch(201, { page: { id: newId, title: "", kind: "unknown" } });
    expect(await duplicatePageRequest(ID)).toEqual({ id: newId, title: "", kind: "note" });
    mockFetch(201, { page: { id: "not-a-uuid", title: "x" } });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 500 });
    mockFetch(201, { page: { id: newId } });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 500 });
    mockFetch(404, { error: "not_found" });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a page with DELETE (204), and keeps the status and code of a refusal", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deletePageRequest(ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}`, expect.objectContaining({ method: "DELETE", credentials: "same-origin", cache: "no-store" }));
    // 応答が来ないまま待ち続けない
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);

    mockFetch(409, { error: "published" });
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ name: "PageActionError", status: 409, code: "published" });
    mockFetch(404, { error: "not_found" });
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ status: 404, code: "not_found" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ status: 502, code: null });
    const encoded = mockFetch(404, { error: "not_found" });
    await expect(deletePageRequest("../trash")).rejects.toThrow(PageActionError);
    expect(encoded).toHaveBeenCalledWith("/api/pages/..%2Ftrash", expect.anything());
  });
});
