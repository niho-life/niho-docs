import { FLOW_TEMPLATES } from "@niho/docs-core";

/**
 * 手順の定義（設計 §7.2）。docs-core のテンプレート（指示文の正）から、記事制作・議事録・インサイト整理の 3 つを写す。
 * コーチング（tpl-4）は §7.2 に無いので含めない。テンプレートが無ければ読み込んだ時点で落とす（起動・build で気づく）。
 */
export const RECIPE_IDS = ["tpl-1", "tpl-2", "tpl-3"] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export type RecipeDef = {
  id: RecipeId;
  name: string;
  steps: { id: string; name: string; instruction: string }[];
};

function fromTemplate(id: RecipeId): RecipeDef {
  const template = FLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template || template.steps.length === 0) throw new Error(`editor-web: the step template ${id} is missing in docs-core`);
  return {
    id,
    name: template.name,
    steps: template.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction })),
  };
}

export const RECIPES: readonly RecipeDef[] = RECIPE_IDS.map(fromTemplate);

export function isRecipeId(value: unknown): value is RecipeId {
  return typeof value === "string" && (RECIPE_IDS as readonly string[]).includes(value);
}

export function findRecipe(id: string): RecipeDef | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}
