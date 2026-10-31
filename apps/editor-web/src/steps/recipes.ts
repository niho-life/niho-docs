import { FLOW_TEMPLATES } from "@niho/docs-core";
import { SETTINGS_ID_PATTERN, type SettingsRecipe } from "@niho/editor-store";

/**
 * 手順の定義（設計 §7.2）。docs-core のテンプレート（指示文の正）から、記事制作・議事録・インサイト整理の 3 つを写す。
 * コーチング（tpl-4）は §7.2 に無いので含めない。テンプレートが無ければ読み込んだ時点で落とす（起動・build で気づく）。
 *
 * 既定の手順はこの定数で、設定（#108）で段階の名前・指示・お手本を変えたもの・足したものは
 * `editor_settings.recipes` に入る。実行のときに使う手順は、その人の保存した手順を既定にかぶせた `recipesOf` の結果
 * （既定の並び → 足したものの並び）。手順を変えると、次に手順を始めたときから効く（進行中の run は claim した
 * ときの定義で続く）。
 */
export const DEFAULT_RECIPE_IDS = ["tpl-1", "tpl-2", "tpl-3"] as const;
export type DefaultRecipeId = (typeof DEFAULT_RECIPE_IDS)[number];

export type RecipeStep = { id: string; name: string; instruction: string };

export type RecipeDef = {
  id: string;
  name: string;
  /** お手本（文書ガイド。全段階の入力に入る）。 */
  guide: string;
  steps: RecipeStep[];
};

function fromTemplate(id: DefaultRecipeId): RecipeDef {
  const template = FLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template || template.steps.length === 0) throw new Error(`editor-web: the step template ${id} is missing in docs-core`);
  return {
    id,
    name: template.name,
    guide: template.guide,
    steps: template.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction })),
  };
}

export const DEFAULT_RECIPES: readonly RecipeDef[] = DEFAULT_RECIPE_IDS.map(fromTemplate);

export function isDefaultRecipeId(value: unknown): value is DefaultRecipeId {
  return typeof value === "string" && (DEFAULT_RECIPE_IDS as readonly string[]).includes(value);
}

/** 手順の id として受け付ける形（既定の `tpl-1` も、設定で足した `r-…` も通る）。存在するかは `findRecipeIn` が見る。 */
export function isRecipeKey(value: unknown): value is string {
  return typeof value === "string" && SETTINGS_ID_PATTERN.test(value);
}

/** 保存した手順を既定にかぶせた、その人の手順。並びは既定の 3 つ（手を入れたものはその場）→ 足したものの保存順。 */
export function recipesOf(saved: readonly SettingsRecipe[] = []): RecipeDef[] {
  const byId = new Map(saved.map((recipe) => [recipe.id, recipe] as const));
  const defaults = DEFAULT_RECIPES.map((recipe) => {
    const override = byId.get(recipe.id);
    return override ? { id: override.id, name: override.name, guide: override.guide, steps: override.steps.map((step) => ({ ...step })) } : recipe;
  });
  const added = saved
    .filter((recipe) => !isDefaultRecipeId(recipe.id))
    .map((recipe) => ({ id: recipe.id, name: recipe.name, guide: recipe.guide, steps: recipe.steps.map((step) => ({ ...step })) }));
  return [...defaults, ...added];
}

export function findRecipeIn(recipes: readonly RecipeDef[], id: string): RecipeDef | undefined {
  return recipes.find((recipe) => recipe.id === id);
}

/** その人の手順を読む（設定から。実行時の配線は src/server/steps-deps.ts）。 */
export type RecipeReader = (owner: string) => Promise<readonly RecipeDef[]>;
