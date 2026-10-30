/** #41 書き出し: Markdown + photos of the last published version of every page on a connection. */

import { describe, expect, it } from "vitest";
import { checkMarkdownSubset } from "@niho/editor-publish-contract";
import { buildExportArchive, yamlString, type ExportArchive, type ExportDoc } from "../src/index.js";
import { ACTOR, FIGURE_BYTES, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, SITE_FIGURE, createSiteWorld, photoBytes, type SiteWorld } from "./support/site-world.js";
import { readZip } from "./support/zip-reader.js";

const PAGE_2 = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
const SLUG = "a-morning-walk-along-the-coast";

async function exported(world: SiteWorld, connectionId: string, actorId = ACTOR): Promise<{ archive: ExportArchive; files: Map<string, Uint8Array> }> {
  const result = await world.connections.exportConnection({ actorId, connectionId });
  if (!result.ok) throw new Error(result.reason);
  return { archive: result, files: new Map(readZip(result.bytes).map((entry) => [entry.name, entry.data])) };
}

const decode = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

async function twoPages(): Promise<{ world: SiteWorld; connectionId: string }> {
  const world = createSiteWorld();
  const { connectionId } = await world.connect();
  // The second page uses the same harbor photo (same bytes, another asset id).
  world.addPage(PAGE_2, { title: "Second walk" }, { id: "asset-figure-02", data: FIGURE_BYTES });
  for (const pageId of [PAGE_ID, PAGE_2]) {
    const result = await world.publish(pageId);
    if (!result.ok) throw new Error(result.reason);
  }
  return { world, connectionId };
}

describe("exportConnection", () => {
  it("writes {slug}.md with a front matter and relative photo paths, and each photo once by sha256", async () => {
    const { world, connectionId } = await twoPages();
    const { archive, files } = await exported(world, connectionId);
    const photo = `photos/${SITE_FIGURE.sha256}.webp`;
    expect(archive.files).toEqual([`${SLUG}.md`, "second-walk.md", photo]);
    expect(archive).toMatchObject({ pages: 2, photos: 1 });
    expect(Array.from(files.get(photo) ?? [])).toEqual(Array.from(FIGURE_BYTES));

    const markdown = decode(files.get(`${SLUG}.md`));
    const version = world.store.versions(PAGE_ID).at(-1)?.snapshot;
    expect(markdown.startsWith([
      "---",
      "title: \"A morning walk along the coast\"",
      "lang: \"en\"",
      `publishedAt: "${version?.publishedAt}"`,
      `updatedAt: "${version?.updatedAt}"`,
      "---",
      "",
      "## Getting there",
    ].join("\n"))).toBe(true);
    expect(markdown).toContain(`![Fishing boats in the harbor](${photo} "The harbor at 7\\:30")`);
    expect(markdown).not.toContain("https://assets.example.com");
    // The same body as the published projection, with the photo source made relative.
    const body = markdown.slice(markdown.indexOf("\n---\n\n") + "\n---\n\n".length);
    expect(body).toBe(version?.markdown.replace(`https://assets.example.com/a/${SITE_FIGURE.sha256}`, photo));
    // In the contract's subset, except that the checker only knows absolute https image sources.
    const violations = checkMarkdownSubset(body);
    expect(violations.map((violation) => violation.reason)).toEqual(["unsafe-image"]);
    expect(checkMarkdownSubset(body.replace(photo, `https://assets.example.com/${photo}`))).toEqual([]);
  });

  it("takes the last published version, stopped pages included, and never the draft", async () => {
    const { world, connectionId } = await twoPages();
    world.editDraft({ title: "Edited but not published" });
    await world.publisher.stop({ actorId: ACTOR, pageId: PAGE_2 });
    const { files } = await exported(world, connectionId);
    expect(decode(files.get(`${SLUG}.md`))).toContain("title: \"A morning walk along the coast\"");
    expect(decode(files.get("second-walk.md"))).toContain("title: \"Second walk\"");
    expect([...files.keys()].join(" ")).not.toContain("edited");
  });

  it("can still be called after disconnecting (by the owner only)", async () => {
    const { world, connectionId } = await twoPages();
    const before = await world.connections.exportConnection({ actorId: ACTOR, connectionId });
    expect((await world.connections.disconnect({ actorId: ACTOR, connectionId })).ok).toBe(true);
    const after = await world.connections.exportConnection({ actorId: ACTOR, connectionId });
    expect(after.ok).toBe(true);
    expect(before.ok && after.ok && Buffer.from(before.bytes).equals(Buffer.from(after.bytes))).toBe(true);
    expect(await world.connections.exportConnection({ actorId: OTHER_ACTOR, connectionId })).toEqual({ ok: false, reason: "not_found" });
  });

  it("only exports the connection's own pages", async () => {
    const { world } = await twoPages();
    const other = await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE, siteUrl: "https://other.example.net" });
    const result = await world.connections.exportConnection({ actorId: OTHER_ACTOR, connectionId: other.connectionId });
    expect(result).toMatchObject({ ok: true, files: [], pages: 0, photos: 0 });
  });

  it("is deterministic", async () => {
    const { world, connectionId } = await twoPages();
    const first = await world.connections.exportConnection({ actorId: ACTOR, connectionId });
    const second = await world.connections.exportConnection({ actorId: ACTOR, connectionId });
    expect(first.ok && second.ok && Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
  });

  it.each([
    ["digest", (world: SiteWorld) => world.assetBytes.set(SITE_FIGURE.sha256, photoBytes("harbor").map((byte, index) => (index === 0 ? byte ^ 1 : byte)))],
    ["size", (world: SiteWorld) => world.assetBytes.set(SITE_FIGURE.sha256, photoBytes("harbor!"))],
    ["missing", (world: SiteWorld) => world.assetBytes.remove(SITE_FIGURE.sha256)],
  ] as const)("a photo whose bytes do not match (%s) fails the export instead of being left out", async (problem, corrupt) => {
    const { world, connectionId } = await twoPages();
    corrupt(world);
    const result = await world.connections.exportConnection({ actorId: ACTOR, connectionId });
    expect(result).toEqual({
      ok: false,
      reason: "asset_invalid",
      assets: [
        { pageId: PAGE_ID, assetId: SITE_FIGURE.id, problem },
        { pageId: PAGE_2, assetId: "asset-figure-02", problem },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("synthetic photo bytes");
  });

  it("an asset store failure is a retryable failure", async () => {
    const { world, connectionId } = await twoPages();
    world.assetBytes.read = async () => {
      throw new Error("asset store down");
    };
    expect(await world.connections.exportConnection({ actorId: ACTOR, connectionId })).toEqual({ ok: false, reason: "failed", retryable: true });
  });
});

describe("buildExportArchive", () => {
  async function baseDoc(): Promise<{ doc: ExportDoc; photos: Map<string, Uint8Array> }> {
    const { world } = await twoPages();
    const doc = world.store.versions(PAGE_ID).at(-1)?.snapshot;
    if (!doc) throw new Error("no version");
    return { doc, photos: new Map([[SITE_FIGURE.sha256, FIGURE_BYTES]]) };
  }

  it("never overwrites a page with the same slug: slug.md, slug-2.md, … (skipping names that are taken)", async () => {
    const { doc, photos } = await baseDoc();
    const docs: ExportDoc[] = [
      { ...doc, id: "00000000-0000-4000-8000-000000000003", title: "Third" },
      { ...doc, id: "00000000-0000-4000-8000-000000000001", title: "First" },
      { ...doc, id: "00000000-0000-4000-8000-000000000002", slug: `${SLUG}-2`, title: "Real -2" },
      { ...doc, id: "00000000-0000-4000-8000-000000000004", title: "Fourth" },
    ];
    const result = await buildExportArchive({ docs, photos });
    if (!result.ok) throw new Error(result.reason);
    const files = new Map(readZip(result.bytes).map((entry) => [entry.name, new TextDecoder().decode(entry.data)]));
    expect(result.files.filter((name) => name.endsWith(".md"))).toEqual([`${SLUG}-2.md`, `${SLUG}-3.md`, `${SLUG}-4.md`, `${SLUG}.md`]);
    expect(files.get(`${SLUG}.md`)).toContain("title: \"First\"");
    expect(files.get(`${SLUG}-2.md`)).toContain("title: \"Real -2\"");
    expect(files.get(`${SLUG}-3.md`)).toContain("title: \"Third\"");
    expect(files.get(`${SLUG}-4.md`)).toContain("title: \"Fourth\"");
  });

  it("escapes front matter values as YAML double-quoted strings", async () => {
    const { doc, photos } = await baseDoc();
    const nel = String.fromCharCode(0x85);
    const separator = String.fromCharCode(0x2028);
    const title = `Walk "east": a\\b #1 - 'x' ${nel}${separator}end`;
    const result = await buildExportArchive({ docs: [{ ...doc, title }], photos });
    if (!result.ok) throw new Error(result.reason);
    const markdown = new TextDecoder().decode(readZip(result.bytes)[0]?.data);
    expect(markdown.split("\n")[1]).toBe("title: \"Walk \\\"east\\\": a\\\\b #1 - 'x' \\u0085\\u2028end\"");
    expect(yamlString("---\nkey: value")).toBe("\"---\\u000akey: value\"");
    expect(JSON.parse(yamlString(title))).toBe(title);
  });

  it.each([
    ["a path in the slug", { slug: "../escape" }],
    ["an absolute slug", { slug: "/escape" }],
    ["a malformed id", { id: "not-a-uuid" }],
    ["a malformed timestamp", { updatedAt: "yesterday" }],
    ["a malformed asset hash", { assets: [{ ...SITE_FIGURE, url: "https://assets.example.com/a/x", alt: "Boats", credit: null, sha256: "../x" }] }],
  ] as const)("refuses a version with %s", async (_label, patch) => {
    const { doc, photos } = await baseDoc();
    const result = await buildExportArchive({ docs: [{ ...doc, ...patch } as unknown as ExportDoc], photos });
    expect(result).toMatchObject({ ok: false, reason: "invalid_page" });
  });

  it("refuses a body whose figure points at no asset", async () => {
    const { doc, photos } = await baseDoc();
    expect(await buildExportArchive({ docs: [{ ...doc, assets: [] }], photos })).toEqual({ ok: false, reason: "markdown_invalid", pageId: PAGE_ID });
  });
});
