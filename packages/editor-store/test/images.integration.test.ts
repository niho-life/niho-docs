import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import {
  completeImageUpload,
  countPageImages,
  findImageUploadByKey,
  imageAsset,
  imageObjectPath,
  sharedImageAsset,
  startImageUpload,
  updateImageMeta,
  type StartImageUploadInput,
} from "../src/images.ts";
import { applyMigrations, defaultMigrationsDir, readMigrations } from "../src/migrate.ts";
import { enableShare, stopShare } from "../src/shares.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・ダミーのハッシュだけを使う（実在の人・実際の画像を入れない）
const OWNER = "synthetic-image-owner-a";
const OTHER = "synthetic-image-owner-b";
const SHA = "a".repeat(64);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

function startInput(pageId: string, extra: Partial<StartImageUploadInput> = {}): StartImageUploadInput {
  return { assetId: randomUUID(), pageId, contentType: "image/png", bytes: 1024, sha256: SHA, uploadKey: null, requestHash: HASH_A, ...extra };
}

async function count(pool: PgPool, owner: string): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM assets WHERE owner = $1", [owner])).rows[0]!.n;
}

describe("0011 on a database that has 0001 to 0010", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("image0011"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0011-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds the upload columns and leaves the existing assets ready", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    const names = (await readMigrations()).map((file) => file.name);
    const earlier = names.filter((name) => name < "0011");
    assert.ok(earlier.includes("0001_editor_store.sql") && earlier.includes("0008_recording_audio.sql"));
    for (const name of earlier) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, earlier);
      // 0011 の前に入っていた資産（音声）
      const page = (await pool.query<{ id: string }>("INSERT INTO pages (owner, kind) VALUES ($1, 'rec') RETURNING id", [OWNER])).rows[0]!.id;
      const assetId = randomUUID();
      await pool.query(
        `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type)
         VALUES ($1, $2, $3, 'audio', $4, 10, $5, 'audio/mp4')`,
        [assetId, OWNER, page, `audio/${assetId}`, SHA],
      );
      const before = (await pool.query("SELECT * FROM assets WHERE id = $1", [assetId])).rows[0]!;

      await copyFile(join(migrations, "0011_image_assets.sql"), join(dir, "0011_image_assets.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0011_image_assets.sql"]);
      assert.deepEqual(second.skipped, earlier);

      const afterRow = (await pool.query("SELECT * FROM assets WHERE id = $1", [assetId])).rows[0]!;
      for (const [column, value] of Object.entries(before)) assert.deepEqual(afterRow[column], value, `${column} is unchanged`);
      assert.equal(afterRow.upload_status, "ready");
      assert.equal(afterRow.upload_key, null);
      assert.equal(afterRow.request_hash, null);
      // 冪等キーは NULL なら重複してよい
      const second2 = randomUUID();
      await pool.query(
        `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type)
         VALUES ($1, $2, $3, 'audio', $4, 10, $5, 'audio/mp4')`,
        [second2, OWNER, page, `audio/${second2}`, SHA],
      );
      assert.equal(await count(pool, OWNER), 2);
    } finally {
      client.release();
    }
  });
});

describe("page images on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let store: EditorStore;

  before(async () => {
    ({ pool, drop } = await withSchema("images"));
    const client = await pool.connect();
    try {
      await applyMigrations(client, defaultMigrationsDir);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await drop();
  });

  const newPage = async (owner = OWNER) => (await store.createPage(owner, { title: "合成のページ" })).id;

  it("starts an upload on the owner's page, completes it when the size matches, and reads it back", async () => {
    const page = await newPage();
    const input = startInput(page);
    const started = await startImageUpload(pool, OWNER, input);
    assert.deepEqual(started, { status: "created", assetId: input.assetId, objectPath: imageObjectPath(input.assetId), uploadStatus: "uploading" });

    const pending = await imageAsset(pool, OWNER, input.assetId);
    assert.deepEqual(pending, {
      assetId: input.assetId,
      pageId: page,
      objectPath: `image/${input.assetId}`,
      status: "uploading",
      bytes: 1024,
      contentType: "image/png",
      sha256: SHA,
      alt: null,
      credit: null,
      // 掲載許諾は false から始まる
      consent: false,
      createdAt: pending!.createdAt,
    });

    // 大きさが申告と違えば何も書かない
    assert.deepEqual(await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1023 }), { status: "size_mismatch" });
    assert.equal((await imageAsset(pool, OWNER, input.assetId))!.status, "uploading");

    const done = await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1024 });
    assert.equal(done?.status, "ok");
    assert.equal(done?.status === "ok" && done.asset.status, "ready");
    // 何度呼んでもよい（冪等）
    const again = await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 999 });
    assert.equal(again?.status === "ok" && again.asset.status, "ready");
    // ページの更新時刻も進む（サイドバーの更新順に出る）
    const updated = (await store.getPage(OWNER, page))!;
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(updated.createdAt));
  });

  it("refuses another owner's page, a page that is not there and a trashed page, writing nothing", async () => {
    const mine = await newPage();
    const theirs = await newPage(OTHER);
    const trashed = await newPage();
    assert.equal(await store.deletePage(OWNER, trashed), "deleted");
    const before = await count(pool, OWNER);
    for (const pageId of [theirs, trashed, randomUUID()]) {
      assert.equal(await startImageUpload(pool, OWNER, startInput(pageId)), null, pageId);
    }
    assert.equal(await count(pool, OWNER), before);
    // 自分のページには入る
    assert.notEqual(await startImageUpload(pool, OWNER, startInput(mine)), null);
    assert.equal(await count(pool, OWNER), before + 1);
  });

  it("keeps another owner's asset invisible, and never lets them complete or change it", async () => {
    const page = await newPage();
    const input = startInput(page);
    await startImageUpload(pool, OWNER, input);
    assert.equal(await imageAsset(pool, OTHER, input.assetId), null);
    assert.equal(await completeImageUpload(pool, OTHER, input.assetId, { sizeBytes: 1024 }), null);
    assert.equal(await updateImageMeta(pool, OTHER, input.assetId, { consent: true }), null);
    assert.equal((await imageAsset(pool, OWNER, input.assetId))!.status, "uploading");
    assert.equal((await imageAsset(pool, OWNER, input.assetId))!.consent, false);
  });

  it("hides the images of a trashed page and refuses to change them", async () => {
    const page = await newPage();
    const input = startInput(page);
    await startImageUpload(pool, OWNER, input);
    await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1024 });
    assert.equal(await store.deletePage(OWNER, page), "deleted");
    assert.equal(await imageAsset(pool, OWNER, input.assetId), null);
    assert.equal(await countPageImages(pool, OWNER, page), null);
    assert.equal(await updateImageMeta(pool, OWNER, input.assetId, { alt: "あと" }), null);
    assert.equal(await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1024 }), null);
    // ゴミ箱から戻せば、また見える（行は消していない）
    assert.equal(await store.restoreFromTrash(OWNER, page), true);
    assert.equal((await imageAsset(pool, OWNER, input.assetId))!.status, "ready");
  });

  it("counts the images of a page for the limit, including the ones still uploading", async () => {
    const page = await newPage();
    assert.equal(await countPageImages(pool, OWNER, page), 0);
    const first = startInput(page);
    await startImageUpload(pool, OWNER, first);
    assert.equal(await countPageImages(pool, OWNER, page), 1);
    const second = startInput(page);
    await startImageUpload(pool, OWNER, second);
    await completeImageUpload(pool, OWNER, second.assetId, { sizeBytes: 1024 });
    assert.equal(await countPageImages(pool, OWNER, page), 2);
    // 別のページ・別の人からは数えない
    const other = await newPage();
    assert.equal(await countPageImages(pool, OWNER, other), 0);
    assert.equal(await countPageImages(pool, OTHER, page), null);
    // 音声の資産は画像として数えない
    const audioId = randomUUID();
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type)
       VALUES ($1, $2, $3, 'audio', $4, 10, $5, 'audio/mp4')`,
      [audioId, OWNER, page, `audio/${audioId}`, SHA],
    );
    assert.equal(await countPageImages(pool, OWNER, page), 2);
    // 画像でない資産は画像の読み書きにも出てこない
    assert.equal(await imageAsset(pool, OWNER, audioId), null);
    assert.equal(await updateImageMeta(pool, OWNER, audioId, { consent: true }), null);
  });

  it("returns the same asset for the same idempotency key and content, and conflicts for other content or another page", async () => {
    const page = await newPage();
    const other = await newPage();
    const key = randomUUID();
    const input = startInput(page, { uploadKey: key });
    const first = await startImageUpload(pool, OWNER, input);
    assert.equal(first?.status, "created");
    const before = await count(pool, OWNER);

    // 同じキー・同じページ・同じ内容（資産の id が違っても、先に作ったものを返す）
    const again = await startImageUpload(pool, OWNER, startInput(page, { uploadKey: key }));
    assert.deepEqual(again, { status: "existing", assetId: input.assetId, objectPath: imageObjectPath(input.assetId), uploadStatus: "uploading" });
    assert.equal(await count(pool, OWNER), before);

    // 済んだあとは ready を返す（呼び出し側は ticket を作り直さない）
    await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1024 });
    const third = await startImageUpload(pool, OWNER, startInput(page, { uploadKey: key }));
    assert.equal(third?.status === "existing" && third.uploadStatus, "ready");

    // 同じキーで内容が違う・ページが違う
    assert.deepEqual(await startImageUpload(pool, OWNER, startInput(page, { uploadKey: key, requestHash: HASH_B })), { status: "conflict" });
    assert.deepEqual(await startImageUpload(pool, OWNER, startInput(other, { uploadKey: key })), { status: "conflict" });
    assert.equal(await count(pool, OWNER), before);

    // 書かずに調べるだけ（上限の判定の前に、冪等な再送を見分ける）: 同じキー・内容は existing、違えば conflict、無ければ null
    assert.deepEqual(await findImageUploadByKey(pool, OWNER, { uploadKey: key, pageId: page, requestHash: HASH_A }), {
      status: "existing",
      assetId: input.assetId,
      objectPath: imageObjectPath(input.assetId),
      uploadStatus: "ready",
    });
    assert.deepEqual(await findImageUploadByKey(pool, OWNER, { uploadKey: key, pageId: page, requestHash: HASH_B }), { status: "conflict" });
    assert.deepEqual(await findImageUploadByKey(pool, OWNER, { uploadKey: key, pageId: other, requestHash: HASH_A }), { status: "conflict" });
    assert.equal(await findImageUploadByKey(pool, OWNER, { uploadKey: randomUUID(), pageId: page, requestHash: HASH_A }), null);
    assert.equal(await count(pool, OWNER), before);

    // 別の人は同じキーを使える（owner ごとに 1 つ）
    const theirPage = await newPage(OTHER);
    assert.equal((await startImageUpload(pool, OTHER, startInput(theirPage, { uploadKey: key })))?.status, "created");

    // キーのページがゴミ箱にあれば、そのキーは使えない
    assert.equal(await store.deletePage(OWNER, page), "deleted");
    assert.deepEqual(await startImageUpload(pool, OWNER, startInput(page, { uploadKey: key })), { status: "conflict" });
  });

  it("lets two requests with the same key race without making two assets", async () => {
    const page = await newPage();
    const key = randomUUID();
    const results = await Promise.all([
      startImageUpload(pool, OWNER, startInput(page, { uploadKey: key })),
      startImageUpload(pool, OWNER, startInput(page, { uploadKey: key })),
      startImageUpload(pool, OWNER, startInput(page, { uploadKey: key })),
    ]);
    const made = results.filter((result) => result?.status === "created");
    const existing = results.filter((result) => result?.status === "existing");
    assert.equal(made.length, 1);
    assert.equal(existing.length, 2);
    assert.equal(await countPageImages(pool, OWNER, page), 1);
  });

  it("saves alt, credit and consent, one field at a time, with an empty value meaning none", async () => {
    const page = await newPage();
    const input = startInput(page);
    await startImageUpload(pool, OWNER, input);
    const withAlt = await updateImageMeta(pool, OWNER, input.assetId, { alt: "合成の写真" });
    assert.deepEqual([withAlt?.alt, withAlt?.credit, withAlt?.consent], ["合成の写真", null, false]);
    const withCredit = await updateImageMeta(pool, OWNER, input.assetId, { credit: "合成の提供元", consent: true });
    assert.deepEqual([withCredit?.alt, withCredit?.credit, withCredit?.consent], ["合成の写真", "合成の提供元", true]);
    const cleared = await updateImageMeta(pool, OWNER, input.assetId, { alt: "", credit: null });
    assert.deepEqual([cleared?.alt, cleared?.credit, cleared?.consent], [null, null, true]);
    // 何も指定しなければ何も変わらない
    const same = await updateImageMeta(pool, OWNER, input.assetId, {});
    assert.deepEqual([same?.alt, same?.credit, same?.consent], [null, null, true]);
    // アップロードが済む前でも欄は直せる（本文の自動保存と同じ値を入れておける）
    assert.equal(same?.status, "uploading");
  });

  it("serves a shared page's ready images by token only, and nothing else", async () => {
    const page = await newPage();
    const other = await newPage();
    const ready = startInput(page);
    const pending = startInput(page);
    const elsewhere = startInput(other);
    for (const input of [ready, pending, elsewhere]) await startImageUpload(pool, OWNER, input);
    await completeImageUpload(pool, OWNER, ready.assetId, { sizeBytes: 1024 });
    await completeImageUpload(pool, OWNER, elsewhere.assetId, { sizeBytes: 1024 });
    await updateImageMeta(pool, OWNER, ready.assetId, { alt: "合成の写真", credit: "合成の提供元" });

    const share = await enableShare(pool, OWNER, page);
    assert.ok(share?.shared);
    const token = share.token;
    assert.deepEqual(await sharedImageAsset(pool, token, ready.assetId), {
      objectPath: `image/${ready.assetId}`,
      contentType: "image/png",
      bytes: 1024,
      alt: "合成の写真",
      credit: "合成の提供元",
    });
    // まだ済んでいない画像（下書き）・別のページの画像・別の token では返さない
    assert.equal(await sharedImageAsset(pool, token, pending.assetId), null);
    assert.equal(await sharedImageAsset(pool, token, elsewhere.assetId), null);
    assert.equal(await sharedImageAsset(pool, "x".repeat(43), ready.assetId), null);
    // 共有を止めたら読めない
    await stopShare(pool, OWNER, page);
    assert.equal(await sharedImageAsset(pool, token, ready.assetId), null);
    // ゴミ箱のページの画像も読めない
    const again = await enableShare(pool, OWNER, page);
    assert.ok(again?.shared);
    assert.equal(await store.deletePage(OWNER, page), "deleted");
    assert.equal(await sharedImageAsset(pool, again.token, ready.assetId), null);
  });

  it("drops the asset rows when the page is purged, and reports their object paths", async () => {
    const page = await newPage();
    const input = startInput(page);
    await startImageUpload(pool, OWNER, input);
    await completeImageUpload(pool, OWNER, input.assetId, { sizeBytes: 1024 });
    assert.equal(await store.deletePage(OWNER, page), "deleted");
    // 保持の日数を過ぎたことにする（purgeTrash は 1 日以上しか受け取らない）
    await pool.query(
      `UPDATE pages
          SET created_at = created_at - make_interval(days => 32),
              updated_at = updated_at - make_interval(days => 32),
              deleted_at = deleted_at - make_interval(days => 31)
        WHERE id = $1`,
      [page],
    );
    const purged = await store.purgeTrash();
    assert.ok(purged.assetPaths.includes(`image/${input.assetId}`), "the object path is reported so the bucket rule can take it");
    assert.equal(await imageAsset(pool, OWNER, input.assetId), null);
  });
});
