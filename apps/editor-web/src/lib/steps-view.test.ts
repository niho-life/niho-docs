import { describe, expect, it } from "vitest";
import { RECIPES } from "@/steps/recipes";
import type { StepRun, StepRunStep } from "./steps-client";
import {
  STEP_RECIPES,
  isStepRunActive,
  stepBandActions,
  stepBandNote,
  stepBandSteps,
  stepDoneMessage,
  stepPagesOf,
  stepRecipeName,
  stepStartChoices,
  stepStateOf,
} from "./steps-view";

const NAMES = ["文字起こし修正", "記事方針", "記事本文"];

function step(index: number, over: Partial<StepRunStep> = {}): StepRunStep {
  return { index, id: `s${index}`, name: NAMES[index] ?? `段階 ${index}`, state: "pending", pageId: `page-${index}`, stepStatus: "wait", tries: 0, errorCode: null, ...over };
}

function run(over: Partial<StepRun> = {}): StepRun {
  return { id: "run-1", recipe: "tpl-1", state: "running", fromStep: 0, steps: [step(0), step(1), step(2)], ...over };
}

describe("steps-view（手順の帯の見た目）", () => {
  it("手順の id と名前が src/steps/recipes.ts の RECIPES と合っている", () => {
    expect(STEP_RECIPES.map((recipe) => [recipe.id, recipe.name])).toEqual(RECIPES.map((recipe) => [recipe.id, recipe.name]));
    expect(stepStartChoices()).toEqual([
      { id: "tpl-1", label: "記事にする" },
      { id: "tpl-2", label: "議事録にする" },
      { id: "tpl-3", label: "インサイトを整理する" },
    ]);
    expect(stepRecipeName("tpl-2")).toBe("議事録");
    // 設定で足した手順（知らない id）でも帯は出す
    expect(stepRecipeName("usr-9")).toBe("usr-9");
  });

  it("段階の状態は、実行中・失敗が先で、そのあとに前提変更", () => {
    expect(stepStateOf(step(0, { state: "running", stepStatus: "run" }))).toBe("run");
    // 実行中なら、前の前提変更の印は出さない（やり直しが走っている）
    expect(stepStateOf(step(0, { state: "running", stepStatus: "stale" }))).toBe("run");
    expect(stepStateOf(step(0, { state: "failed", stepStatus: "failed", errorCode: "invalid_output" }))).toBe("failed");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "done" }))).toBe("done");
    expect(stepStateOf(step(0, { state: "reused", stepStatus: "done" }))).toBe("done");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "stale" }))).toBe("stale");
    // サブページをゴミ箱へ入れた（結果が無い）ので、その段階から作り直せる扱いにする
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: null }))).toBe("stale");
    expect(stepStateOf(step(0, { state: "queued" }))).toBe("wait");
    expect(stepStateOf(step(0, { state: "pending" }))).toBe("wait");
    expect(stepStateOf(step(0, { state: "canceled", stepStatus: "wait" }))).toBe("wait");
  });

  it("帯の段階は、サブページの id・段階の名前・状態（段階の名前はサーバーが返す値のまま）", () => {
    const view = run({ steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "running" }), step(2)] });
    expect(stepBandSteps(view)).toEqual([
      { id: "page-0", label: "文字起こし修正", state: "done" },
      { id: "page-1", label: "記事方針", state: "run" },
      { id: "page-2", label: "記事本文", state: "wait" },
    ]);
  });

  it("動いているかどうかで、読み直すかを決める", () => {
    expect(isStepRunActive(null)).toBe(false);
    expect(isStepRunActive(run({ state: "queued" }))).toBe(true);
    expect(isStepRunActive(run({ state: "running" }))).toBe(true);
    for (const state of ["succeeded", "failed", "canceled"] as const) expect(isStepRunActive(run({ state }))).toBe(false);
  });

  it("帯の下の一言が、いま何が起きているかを言う", () => {
    expect(stepBandNote(run({ state: "queued" }))).toBe("順番を待っています。画面を閉じても進みます。");
    expect(stepBandNote(run({ steps: [step(0, { state: "running" }), step(1), step(2)] }))).toBe("「文字起こし修正」を作成中です。画面を閉じても進みます。");
    expect(stepBandNote(run({ state: "canceled" }))).toBe("手順を取消しました。もう一度始められます。");
    expect(
      stepBandNote(
        run({
          state: "failed",
          steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", errorCode: "invalid_output" }), step(2)],
        }),
      ),
    ).toBe("「記事方針」が失敗しました（AI の答えを本文にできなかった）。この段階からやり直せます。");
    // 知らない code は言葉にしない（内部の情報を画面に出さない）
    expect(stepBandNote(run({ state: "failed", steps: [step(0, { state: "failed", errorCode: "something_new" })] }))).toBe(
      "「文字起こし修正」が失敗しました。この段階からやり直せます。",
    );
    const stale = run({
      state: "succeeded",
      steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "stale" }), step(2, { state: "succeeded", stepStatus: "stale" })],
    });
    expect(stepBandNote(stale)).toBe("上流のページが変わりました。「記事方針」から作り直すと印が消えます。");
    expect(stepBandNote(run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" })] }))).toBe("すべての段階が済みました。");
  });

  it("動いている間は「やめる」だけ", () => {
    expect(stepBandActions(run({ state: "running" }), "page-1")).toEqual([{ id: "cancel", label: "やめる", tone: "quiet", cancel: true }]);
  });

  it("失敗した段階・前提が変わった段階からやり直せる（その段階だけを指す）", () => {
    const failed = run({
      state: "failed",
      steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", errorCode: "internal" }), step(2)],
    });
    // 録音ページ（どの段階でもない）を開いているとき
    expect(stepBandActions(failed, "rec")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
    // その失敗した段階のページを開いているときは、同じことを二度出さない
    expect(stepBandActions(failed, "page-1").map((action) => action.id)).toEqual(["retry", "restart"]);
    // 別の段階のページを開いていれば、その段階からの作り直しも出す
    expect(stepBandActions(failed, "page-2")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "redo-here", label: "この手順を作り直す", tone: "outline", fromStep: 2 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("すべて済んでいるサブページでは「この手順を作り直す」が主ボタン", () => {
    const done = run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "done" })] });
    expect(stepBandActions(done, "page-1")).toEqual([
      { id: "redo-here", label: "この手順を作り直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("サイドバーへ渡す行と、終わったときの通知の一言", () => {
    const view = run({ steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { stepStatus: null })] });
    expect(stepPagesOf(view)).toEqual([
      { id: "page-0", title: "文字起こし修正", stepStatus: "done" },
      { id: "page-1", title: "記事方針", stepStatus: null },
    ]);
    expect(stepDoneMessage(run({ state: "succeeded" }))).toBe("記事制作の手順が終わりました。");
    expect(stepDoneMessage(run({ state: "failed", steps: [step(0, { state: "failed" })] }))).toBe("記事制作の手順が「文字起こし修正」で失敗しました。");
    expect(stepDoneMessage(run({ state: "running" }))).toBeNull();
    expect(stepDoneMessage(run({ state: "canceled" }))).toBeNull();
  });
});
