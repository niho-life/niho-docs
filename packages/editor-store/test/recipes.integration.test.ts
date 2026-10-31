import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { addRecipes, listRecipes, putRecipes, recipesProblem, seedRecipes, type RecipeInput } from "../src/recipes.ts";
import { saveEditorSettings } from "../src/settings.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の手順だけを使う
const OWNER = "synthetic-recipes-owner-a";
const OTHER = "synthetic-recipes-owner-b";

/** 既定の 3 つの代わり（中身は短い合成の値。長さの効く検査は guide の 2 万字で別に見る）。 */
const article: RecipeInput = {
  id: "tpl-1",
  name: "記事制作",
  guide: "## 記事の目的\n合成のお手本。",
  steps: [
    { id: "k7m2q9xa", name: "文字起こし修正", instruction: "合成の指示（整える）。", profile: "light" },
    { id: "r4t8wz3c", name: "記事方針", instruction: "合成の指示（方針）。", profile: "advanced", provider: "claude" },
  ],
  terms: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" }],
  samples: [{ id: "sa-1", name: "合成のお手本.md", chars: 1200 }],
  origin: "builtin",
};
const minutes: RecipeInput = {
  id: "tpl-2",
  name: "議事録",
  guide: "",
  steps: [{ id: "d9c3x7mf", name: "議事録", instruction: "合成の指示（議事録）。", profile: "standard" }],
  origin: "builtin",
};
const added: RecipeInput = {
  id: "r-talk",
  name: "対談",
  steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。", profile: "standard" }],
};

describe("recipes table (0021)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_recipes_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("is empty for someone who never saved, and seeds the passed recipes once", async () => {
    assert.deepEqual(await listRecipes(pool, OWNER), []);
    const seeded = await seedRecipes(pool, OWNER, [article, minutes]);
    assert.deepEqual(
      seeded.map((recipe) => [recipe.id, recipe.name, recipe.origin, recipe.sortOrder, recipe.revision]),
      [
        ["tpl-1", "記事制作", "builtin", 0, 1],
        ["tpl-2", "議事録", "builtin", 1, 1],
      ],
    );
    // 工程・プロファイル・固有名詞・お手本は入れたまま返る
    assert.deepEqual(seeded[0]?.steps, article.steps);
    assert.deepEqual(seeded[0]?.terms, article.terms);
    assert.deepEqual(seeded[0]?.samples, article.samples);
    assert.equal(seeded[0]?.guide, article.guide);
    assert.equal(seeded[0]?.importedFrom, null);

    // 2 回目は何も書かない（消した手順を勝手に戻さない）
    const again = await seedRecipes(pool, OWNER, [article, minutes, added]);
    assert.deepEqual(again.map((recipe) => recipe.id), ["tpl-1", "tpl-2"]);
  });

  it("keeps each person's recipes to themselves", async () => {
    await seedRecipes(pool, OTHER, [added]);
    assert.deepEqual((await listRecipes(pool, OTHER)).map((recipe) => recipe.id), ["r-talk"]);
    assert.deepEqual((await listRecipes(pool, OWNER)).map((recipe) => recipe.id), ["tpl-1", "tpl-2"]);
    // 同じ id は人ごとに別の行
    await putRecipes(pool, OTHER, [{ ...article, name: "別の人の記事制作" }]);
    assert.equal((await listRecipes(pool, OWNER))[0]?.name, "記事制作");
  });

  it("replaces the whole list in the passed order, and drops what was left out", async () => {
    const saved = await putRecipes(pool, OWNER, [minutes, article, added]);
    assert.deepEqual(saved.map((recipe) => [recipe.id, recipe.sortOrder]), [
      ["tpl-2", 0],
      ["tpl-1", 1],
      ["r-talk", 2],
    ]);
    assert.equal(saved[2]?.origin, "own");
    const fewer = await putRecipes(pool, OWNER, [article, minutes]);
    assert.deepEqual(fewer.map((recipe) => recipe.id), ["tpl-1", "tpl-2"]);
  });

  it("counts a revision only when the contents change, not when the order does", async () => {
    const before = await putRecipes(pool, OWNER, [article, minutes]);
    const reordered = await putRecipes(pool, OWNER, [minutes, article]);
    assert.deepEqual(
      reordered.map((recipe) => recipe.revision),
      [before[1]!.revision, before[0]!.revision],
      "並べ替えだけなら版は増えない",
    );
    const edited = await putRecipes(pool, OWNER, [minutes, { ...article, name: "記事制作（短め）" }]);
    assert.equal(edited[1]?.revision, before[0]!.revision + 1);
    assert.equal(edited[0]?.revision, before[1]!.revision);
  });

  it("stores a 2 万字 guide and a 12 工程 recipe as they are", async () => {
    const guide = `## ${"あ".repeat(19_990)}`;
    const long: RecipeInput = {
      id: "r-long",
      name: "長い手順",
      guide,
      steps: Array.from({ length: 12 }, (_, index) => ({
        id: `s-${index}`,
        name: `段 ${index}`,
        instruction: `${"合成の指示。".repeat(100)}\n- 行`,
        profile: "standard",
      })),
    };
    const saved = await putRecipes(pool, OWNER, [long]);
    assert.equal(saved[0]?.guide, guide);
    assert.equal(saved[0]?.steps.length, 12);
    assert.deepEqual(saved[0]?.steps, long.steps);
  });

  it("refuses a list the screen could not have made, writing nothing", async () => {
    const kept = (await listRecipes(pool, OWNER)).map((recipe) => recipe.id);
    const bad: { why: string; value: RecipeInput[] }[] = [
      { why: "id", value: [{ ...added, id: "R-Talk" }] },
      { why: "name", value: [{ ...added, name: "  " }] },
      { why: "steps", value: [{ ...added, steps: [] }] },
      { why: "steps（プロファイルが無い）", value: [{ ...added, steps: [{ id: "s-1", name: "まとめ", instruction: "" } as never] }] },
      { why: "steps（同じ id）", value: [{ ...added, steps: [added.steps[0]!, added.steps[0]!] }] },
      { why: "id（同じ手順が 2 つ）", value: [added, added] },
      { why: "count", value: Array.from({ length: 21 }, (_, index) => ({ ...added, id: `r-${index}` })) },
      { why: "origin", value: [{ ...added, origin: "legacy" as never }] },
      { why: "origin（取り込みでないのに元の id）", value: [{ ...added, importedFrom: "flow-1" }] },
    ];
    for (const { why, value } of bad) {
      assert.ok(recipesProblem(value) !== null, why);
      await assert.rejects(() => putRecipes(pool, OWNER, value), TypeError, why);
    }
    assert.deepEqual((await listRecipes(pool, OWNER)).map((recipe) => recipe.id), kept);
  });

  it("adds only the recipes that are not there yet, after the ones already saved (既定が増えたとき)", async () => {
    await putRecipes(pool, OWNER, [article, added]);
    const before = await listRecipes(pool, OWNER);
    // すでにある手順は中身も並びも版も変えず、無いものだけを後ろに足す
    const after = await addRecipes(pool, OWNER, [{ ...article, name: "書き換えない" }, minutes]);
    assert.deepEqual(after.map((recipe) => [recipe.id, recipe.sortOrder]), [
      ["tpl-1", 0],
      ["r-talk", 1],
      ["tpl-2", 2],
    ]);
    assert.equal(after[0]?.name, "記事制作");
    assert.equal(after[0]?.revision, before[0]!.revision);
    // もう一度足しても増えない
    assert.deepEqual((await addRecipes(pool, OWNER, [minutes])).map((recipe) => recipe.id), ["tpl-1", "r-talk", "tpl-2"]);
  });

  it("refuses an empty owner before reaching the database", async () => {
    await assert.rejects(() => listRecipes(pool, ""), TypeError);
    await assert.rejects(() => putRecipes(pool, "", [added]), TypeError);
    await assert.rejects(() => seedRecipes(pool, "", [added]), TypeError);
    await assert.rejects(() => addRecipes(pool, "", [added]), TypeError);
  });

  it("holds an imported recipe with the old id, so that 旧 NIHO docs の取り込み can be added later", async () => {
    const imported: RecipeInput = { ...added, id: "r-imported", origin: "import", importedFrom: "synthetic-old-flow-1" };
    const saved = await putRecipes(pool, OWNER, [imported]);
    assert.deepEqual([saved[0]?.origin, saved[0]?.importedFrom], ["import", "synthetic-old-flow-1"]);
  });

  it("leaves editor_settings alone (the 0013 column is only read for the one-time carry-over)", async () => {
    await saveEditorSettings(pool, OWNER, { recipes: [{ id: "tpl-2", name: "議事録（短め）", guide: "", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] }] });
    await putRecipes(pool, OWNER, [article]);
    const row = await pool.query<{ ids: string[] }>("SELECT ARRAY(SELECT jsonb_array_elements(recipes) ->> 'id') AS ids FROM editor_settings WHERE owner = $1", [OWNER]);
    assert.deepEqual(row.rows[0]?.ids, ["tpl-2"]);
  });
});
