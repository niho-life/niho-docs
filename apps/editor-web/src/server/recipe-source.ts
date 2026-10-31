import "server-only";
import { addRecipes, getEditorSettings, listRecipes, putRecipes, seedRecipes, type Database, type OwnerId, type Queryable } from "@niho/editor-store";
import { DEFAULT_RECIPES, recipesFromStored, recipesOf, toRecipeInputs, type RecipeDef } from "../steps/recipes";

/**
 * その人の手順の出どころ（表 `recipes`。migration `20261101001500_recipes`）。
 *
 * - 手順の実体は表。固定だった既定の 3 つ（docs-core のテンプレートの写し。`DEFAULT_RECIPES`）は、その人の行が 1 つも
 *   無いときの 1 回だけ表へ写す。写すときに、0013 の `editor_settings.recipes`（既定に手を入れた分・足した分）も一緒に
 *   かぶせる（この表より前から使っている人の引き継ぎ）。この列を読むのは、ここだけ。
 * - 引き継ぎが要らなくなる配備の 1 つ後に、列と `recipesOf` を落とす（expand → contract）。
 * - 消した手順を勝手に戻さないため、行が 1 つでもあれば写さない（設定の PATCH は既定の手順が揃っていることを求めるので、
 *   画面からは空にできない）。
 * - **既定の手順が増えたときは、その手順だけを足す**（`DEFAULT_RECIPE_IDS` に 1 つ足せば、もう表に行がある人にも届く）。
 *   足した手順は並びの後ろに付く。
 */
export async function ownerRecipes(db: Database, owner: OwnerId): Promise<RecipeDef[]> {
  const rows = await listRecipes(db, owner);
  if (rows.length === 0) return recipesFromStored(await carryOver(db, owner));
  const known = new Set(rows.map((row) => row.id));
  const missing = DEFAULT_RECIPES.filter((recipe) => !known.has(recipe.id));
  if (missing.length === 0) return recipesFromStored(rows);
  return recipesFromStored(await addRecipes(db, owner, toRecipeInputs(missing)));
}

async function carryOver(db: Queryable, owner: OwnerId) {
  const settings = await getEditorSettings(db, owner);
  return seedRecipes(db, owner, toRecipeInputs(recipesOf(settings.recipes)));
}

/** その人の手順をすべて入れ替える（渡した順が並び）。設定の画面（`PATCH /api/settings`）から呼ぶ。 */
export async function saveOwnerRecipes(db: Database, owner: OwnerId, recipes: readonly RecipeDef[]): Promise<RecipeDef[]> {
  return recipesFromStored(await putRecipes(db, owner, toRecipeInputs(recipes)));
}
