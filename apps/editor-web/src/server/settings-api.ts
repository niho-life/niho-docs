import {
  SETTINGS_LIMITS,
  settingsProblem,
  type EditorSettings,
  type EditorSettingsPatch,
  type OwnerId,
  type SettingsAiLang,
  type SettingsRecipe,
  type SettingsTerm,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { DEFAULT_RECIPES, findRecipeIn, isDefaultRecipeId, recipeFromSettings, type RecipeDef } from "../steps/recipes";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, readJsonBody } from "./http";

/**
 * アカウントの設定の API（Issue #108。`GET /api/settings`・`PATCH /api/settings`）。
 *
 * - 本人のものだけ。未認証は 401、DB が使えないときは 503。更新は同じ origin の画面からだけ（違えば 403）。
 * - 持つのは画面から変えられるものだけ（AI の提案の言語・固有名詞・手順）。文字起こしのエンジンはサーバーの設定、
 *   保存先は NIHO から毎回読むので、この API では変えられない（画面は読むだけ。設計 §2.1）。
 * - 手順は「効いている手順の全部」を送り受けする（実体は表 `recipes`。migration 20261101001500_recipes）。既定の値をそのまま送れば
 *   「既定に戻す」になる。既定でない手順を送らなければ、その手順は消える。
 * - この API が送り受けするのは手順の名前・お手本・段階の名前と指示だけで、工程のプロファイル・固有名詞・お手本の文書は
 *   そのまま残す（`mergeRecipes`。それらを変えるのは工程設計の画面）。
 * - 応答の本文に鍵・token は無い（この API はそういう値を持たない）。失敗は短い code だけを返す。
 */

export type SettingsStore = {
  get: (owner: OwnerId) => Promise<EditorSettings>;
  save: (owner: OwnerId, patch: EditorSettingsPatch) => Promise<EditorSettings>;
  /** その人の手順（表 `recipes`）。 */
  recipes: (owner: OwnerId) => Promise<RecipeDef[]>;
  /** その人の手順をすべて入れ替える（渡した順が並び）。 */
  saveRecipes: (owner: OwnerId, recipes: readonly RecipeDef[]) => Promise<RecipeDef[]>;
};

export type SettingsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  settings: () => SettingsStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * 画面に出す 1 つの手順。`isDefault` は既定の 3 つのどれか、`modified` は既定に手を入れているか（戻せる）。
 * `defaults` は既定の手順の元の定義（既定でない手順は null）。「既定に戻す」は、この値で置き換えた一覧を送る
 * （既定の手順を一覧から外すのではない。PATCH は既定の 3 つが揃っていることを求める）。
 */
export type SettingsRecipeDto = SettingsRecipe & { isDefault: boolean; modified: boolean; defaults: Omit<SettingsRecipe, "id"> | null };

export type SettingsDto = {
  aiLang: SettingsAiLang;
  glossary: SettingsTerm[];
  /** 効いている手順（既定の並び → 足したものの並び）。 */
  recipes: SettingsRecipeDto[];
  limits: typeof SETTINGS_LIMITS;
};

/** 設定の画面が送り受けする形（工程のプロファイル・固有名詞・お手本の文書は持たない）。 */
function toSettingsRecipe(recipe: RecipeDef): SettingsRecipe {
  return { id: recipe.id, name: recipe.name, guide: recipe.guide, steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction })) };
}

function sameRecipe(a: SettingsRecipe, b: SettingsRecipe): boolean {
  if (a.name !== b.name || a.guide !== b.guide || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => {
    const other = b.steps[index]!;
    return step.id === other.id && step.name === other.name && step.instruction === other.instruction;
  });
}

export function settingsDto(settings: EditorSettings, recipes: readonly RecipeDef[]): SettingsDto {
  return {
    aiLang: settings.aiLang,
    glossary: settings.glossary,
    recipes: recipes.map((stored) => {
      const recipe = toSettingsRecipe(stored);
      const base = findRecipeIn(DEFAULT_RECIPES, recipe.id);
      const defaults = base ? toSettingsRecipe(base) : null;
      return {
        ...recipe,
        isDefault: base !== undefined,
        modified: defaults !== null && !sameRecipe(recipe, defaults),
        defaults: defaults ? { name: defaults.name, guide: defaults.guide, steps: defaults.steps } : null,
      };
    }),
    limits: SETTINGS_LIMITS,
  };
}

/**
 * 送られてきた手順を、いまの手順（表の行）に重ねる。名前・お手本・段階の名前と指示は送られてきたもの、
 * 工程のプロファイル・この手順の固有名詞・お手本の文書はいまの行のまま（無ければ既定の手順のもの）。
 */
export function mergeRecipes(current: readonly RecipeDef[], sent: readonly SettingsRecipe[]): RecipeDef[] {
  return sent.map((recipe) => recipeFromSettings(recipe, findRecipeIn(current, recipe.id) ?? findRecipeIn(DEFAULT_RECIPES, recipe.id)));
}

/** 手順は別の表なので、設定の列への patch（aiLang・glossary）と分けて持つ。 */
type PatchResult = { ok: true; value: EditorSettingsPatch; recipes?: SettingsRecipe[] } | { ok: false };

/**
 * PATCH の本文（`{ aiLang?, glossary?, recipes? }` だけ）。手順は既定の 3 つの id を 1 回ずつ含み、
 * 段階の id は既定の手順ではそのままでなければならない（成果物のサブページがその id に結んでいる）。
 */
export function parseSettingsPatch(body: unknown): PatchResult {
  if (settingsProblem(body) !== null) return { ok: false };
  const patch = body as EditorSettingsPatch;
  if (patch.recipes !== undefined) {
    const ids = patch.recipes.filter((recipe) => isDefaultRecipeId(recipe.id)).map((recipe) => recipe.id);
    if (ids.length !== DEFAULT_RECIPES.length) return { ok: false };
    for (const recipe of patch.recipes) {
      const base = findRecipeIn(DEFAULT_RECIPES, recipe.id);
      if (!base) continue;
      const stepIds = recipe.steps.map((step) => step.id);
      if (stepIds.length !== base.steps.length || stepIds.some((id, index) => id !== base.steps[index]!.id)) return { ok: false };
    }
    const { recipes, ...rest } = patch;
    return { ok: true, value: rest, recipes };
  }
  return { ok: true, value: patch };
}

/** GET /api/settings — 今の設定（行が無い人も既定値で答える）。 */
export function getSettings(request: Request, deps: SettingsApiDeps): Promise<Response> {
  return guarded("GET /api/settings", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.settings();
    if (!store) return errorResponse("unavailable");
    const [settings, recipes] = await Promise.all([store.get(session.userId), store.recipes(session.userId)]);
    return jsonResponse(200, { settings: settingsDto(settings, recipes) });
  });
}

/** PATCH /api/settings — 渡した項目だけを入れ替え、入れ替えた後の設定を返す。 */
export function patchSettings(request: Request, deps: SettingsApiDeps): Promise<Response> {
  return guarded("PATCH /api/settings", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.settings();
    if (!store) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const patch = parseSettingsPatch(body.value);
    if (!patch.ok) return errorResponse("bad_request");
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const settings = await store.save(owner, patch.value);
    // 手順は別の表。送られてこなければ今のまま読む
    const recipes = patch.recipes ? await store.saveRecipes(owner, mergeRecipes(await store.recipes(owner), patch.recipes)) : await store.recipes(owner);
    return jsonResponse(200, { settings: settingsDto(settings, recipes) });
  });
}
