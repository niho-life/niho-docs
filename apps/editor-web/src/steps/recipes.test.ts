import { FLOW_TEMPLATES, stepHash } from "@niho/docs-core";
import { instructionHash } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { RECIPES, findRecipe, isRecipeId } from "./recipes";

describe("recipes", () => {
  it("copies the three templates of design §7.2 from docs-core, without coaching", () => {
    expect(RECIPES.map((recipe) => [recipe.id, recipe.name, recipe.steps.length])).toEqual([
      ["tpl-1", "記事制作", 3],
      ["tpl-2", "議事録", 2],
      ["tpl-3", "インサイト整理", 1],
    ]);
    expect(RECIPES.flatMap((recipe) => recipe.steps.map((step) => step.id))).toEqual(["k7m2q9xa", "r4t8wz3c", "h2n6v5pe", "d9c3x7mf", "w5q1j8ks", "u3e7z6rh"]);
    expect(findRecipe("tpl-4")).toBeUndefined();
    expect(isRecipeId("tpl-4")).toBe(false);
    expect(isRecipeId("tpl-1")).toBe(true);
    expect(findRecipe("tpl-2")?.steps.map((step) => step.name)).toEqual(["議事録", "共有用の要約"]);
  });

  it("keeps the instructions of docs-core as they are", () => {
    for (const recipe of RECIPES) {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === recipe.id);
      expect(recipe.steps).toEqual(template?.steps.map(({ id, name, instruction }) => ({ id, name, instruction })));
    }
  });

  it("hashes instructions in editor-store exactly like docs-core's stepHash (the input basis depends on it)", () => {
    const samples = [...FLOW_TEMPLATES.flatMap((template) => template.steps.map((step) => step.instruction)), "", "  前後の空白  \n", "合成の指示"];
    for (const instruction of samples) expect(instructionHash(instruction)).toBe(stepHash(instruction));
  });
});
