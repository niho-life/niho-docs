import { FLOW_TEMPLATES, stepHash } from "@niho/docs-core";
import { instructionHash, type SettingsRecipe } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { DEFAULT_RECIPES, findRecipeIn, isDefaultRecipeId, isRecipeKey, recipesOf } from "./recipes";

const added: SettingsRecipe = { id: "r-1", name: "座談会", guide: "お手本", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }] };

describe("recipes", () => {
  it("copies the three templates of design §7.2 from docs-core, without coaching", () => {
    expect(DEFAULT_RECIPES.map((recipe) => [recipe.id, recipe.name, recipe.steps.length])).toEqual([
      ["tpl-1", "記事制作", 3],
      ["tpl-2", "議事録", 2],
      ["tpl-3", "インサイト整理", 1],
    ]);
    expect(DEFAULT_RECIPES.flatMap((recipe) => recipe.steps.map((step) => step.id))).toEqual(["k7m2q9xa", "r4t8wz3c", "h2n6v5pe", "d9c3x7mf", "w5q1j8ks", "u3e7z6rh"]);
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-4")).toBeUndefined();
    expect(isDefaultRecipeId("tpl-4")).toBe(false);
    expect(isDefaultRecipeId("tpl-1")).toBe(true);
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-2")?.steps.map((step) => step.name)).toEqual(["議事録", "共有用の要約"]);
  });

  it("keeps the instructions and the guide of docs-core as they are", () => {
    for (const recipe of DEFAULT_RECIPES) {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === recipe.id);
      expect(recipe.steps).toEqual(template?.steps.map(({ id, name, instruction }) => ({ id, name, instruction })));
      expect(recipe.guide).toBe(template?.guide);
    }
  });

  it("hashes instructions in editor-store exactly like docs-core's stepHash (the input basis depends on it)", () => {
    const samples = [...FLOW_TEMPLATES.flatMap((template) => template.steps.map((step) => step.instruction)), "", "  前後の空白  \n", "合成の指示"];
    for (const instruction of samples) expect(instructionHash(instruction)).toBe(stepHash(instruction));
  });

  it("accepts the ids of both the default and the added recipes, and nothing else", () => {
    for (const id of ["tpl-1", "r-1", "a", "a-b-c", "r-0123456789abcdef"]) expect(isRecipeKey(id), id).toBe(true);
    for (const id of ["", "Tpl-1", "-x", "tpl_1", "a".repeat(65), "tpl 1", null, 1]) expect(isRecipeKey(id), String(id)).toBe(false);
  });
});

describe("recipesOf", () => {
  it("answers the defaults when nothing is saved", () => {
    expect(recipesOf()).toEqual(DEFAULT_RECIPES);
    expect(recipesOf([])).toEqual(DEFAULT_RECIPES);
  });

  it("lays a saved copy over the default of the same id, in the default's place", () => {
    const override: SettingsRecipe = { id: "tpl-2", name: "議事録（短め）", guide: "短く", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] };
    const recipes = recipesOf([override]);
    expect(recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3"]);
    expect(recipes[1]).toEqual(override);
    // 既定の定数は書き換えない
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-2")?.name).toBe("議事録");
  });

  it("puts the added recipes after the defaults, in the saved order", () => {
    const second: SettingsRecipe = { ...added, id: "r-2", name: "対談" };
    const recipes = recipesOf([second, added]);
    expect(recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "r-2", "r-1"]);
    expect(findRecipeIn(recipes, "r-1")).toEqual(added);
  });

  it("hands out copies, so that a caller cannot change the next reader's recipe", () => {
    const recipes = recipesOf([added]);
    recipes[3]!.steps[0]!.name = "書き換え";
    expect(findRecipeIn(recipesOf([added]), "r-1")?.steps[0]?.name).toBe("まとめ");
  });
});
