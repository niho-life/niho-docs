/**
 * 手順（#37）の帯の見た目を、サーバーの run（./steps-client.ts）から組む純粋な部分。通信・React は持たない。
 * 設計 §7.2。段階の状態（済み・作成中・待機・失敗・前提変更）と、その状態でできること（やり直す・作り直す・やめる）を決める。
 *
 * 状態の正はサーバー（step_attempts の state とサブページの step_status）で、ここでは測り直さない。
 * 段階の名前も run が持ってくる値をそのまま使う（設定で手順を変えても帯はそれに従う）。
 */

import type { ShellStep, ShellStepState } from "niho-docs-ui/shell";
import type { StepPageStatus, StepRun, StepRunStep } from "./steps-client";

/** 録音から始められる手順。id と名前は src/steps/recipes.ts の RECIPES の写し（steps-view.test.ts が一致を確かめる）。 */
export const STEP_RECIPES = [
  { id: "tpl-1", name: "記事制作", start: "記事にする" },
  { id: "tpl-2", name: "議事録", start: "議事録にする" },
  { id: "tpl-3", name: "インサイト整理", start: "インサイトを整理する" },
] as const;

export type StepRecipeKey = (typeof STEP_RECIPES)[number]["id"];

/** 「この録音から」の選び方（最初の 1 つが主ボタン）。 */
export function stepStartChoices(): { id: string; label: string }[] {
  return STEP_RECIPES.map((recipe) => ({ id: recipe.id, label: recipe.start }));
}

/** 手順の名前（知らない id は id のまま出す。設定で足した手順でも帯は出る）。 */
export function stepRecipeName(recipeId: string): string {
  return STEP_RECIPES.find((recipe) => recipe.id === recipeId)?.name ?? recipeId;
}

/** まだ動いているか（これが true の間だけ状態を読み直す）。 */
export function isStepRunActive(run: StepRun | null): boolean {
  return run !== null && (run.state === "queued" || run.state === "running");
}

/**
 * 1 つの段階の状態。実行中・失敗が先で、そのあとに前提変更（サブページは出来ているが、上流が変わった）。
 * サブページを削除すると `stepStatus` が null になる。結果が無いので「前提変更」と同じ扱いにし、その段階から作り直せるようにする。
 */
export function stepStateOf(step: StepRunStep): ShellStepState {
  if (step.state === "running") return "run";
  if (step.state === "failed") return "failed";
  const done = step.state === "succeeded" || step.state === "reused";
  if (step.stepStatus === "stale" || (done && step.stepStatus === null)) return "stale";
  if (done) return "done";
  return "wait";
}

/** 帯の段階（id はサブページの id。押すとそのページへ行く）。 */
export function stepBandSteps(run: StepRun): ShellStep[] {
  return run.steps.map((step) => ({ id: step.pageId, label: step.name, state: stepStateOf(step) }));
}

/** 失敗の理由の一言（短い code → 日本語。知らない code は言葉にしない）。 */
const REASONS: Readonly<Record<string, string>> = {
  internal: "思わぬ失敗",
  lease_expired: "時間切れ",
  aborted: "途中で止まった",
  invalid_output: "AI の答えを本文にできなかった",
  invalid_input: "入力が足りない",
  unknown_step: "手順が変わった",
};

function reasonOf(errorCode: string | null): string {
  if (errorCode === null) return "";
  return REASONS[errorCode] ?? "";
}

const quoted = (name: string) => `「${name}」`;

/**
 * 帯の下の一言。いま何が起きているか、何ができるかを 1 文で。変わると読み上げる（ShellSteps の role="status"）。
 * 「画面を閉じても進みます」は受入の約束（閉じても実行は続く）を利用者に伝える一言。
 */
export function stepBandNote(run: StepRun): string {
  const running = run.steps.find((step) => step.state === "running");
  const failed = run.steps.find((step) => step.state === "failed");
  const stale = run.steps.find((step) => stepStateOf(step) === "stale");
  if (run.state === "queued" || run.state === "running") {
    if (running) return `${quoted(running.name)}を作成中です。画面を閉じても進みます。`;
    return "順番を待っています。画面を閉じても進みます。";
  }
  if (run.state === "canceled") return "手順を取消しました。もう一度始められます。";
  if (run.state === "failed" && failed) {
    const reason = reasonOf(failed.errorCode);
    return `${quoted(failed.name)}が失敗しました${reason ? `（${reason}）` : ""}。この段階からやり直せます。`;
  }
  if (stale) return `上流のページが変わりました。${quoted(stale.name)}から作り直すと印が消えます。`;
  if (run.state === "succeeded") return "すべての段階が済みました。";
  return "";
}

/** 帯のボタン。`fromStep` を持つものはその段階からの再実行、`cancel` は取消。 */
export type StepBandAction = {
  id: string;
  label: string;
  tone: "primary" | "outline" | "quiet";
  fromStep?: number;
  cancel?: boolean;
};

/**
 * その状態でできること。動いている間は「やめる」だけ。終わっていれば、失敗した段階・前提が変わった段階からのやり直しを主ボタンにし、
 * 手順のサブページを開いているときは「この手順を作り直す」（その段階から）も出す。はじめからの作り直しはいつでもできる。
 */
export function stepBandActions(run: StepRun, currentPageId: string): StepBandAction[] {
  if (isStepRunActive(run)) return [{ id: "cancel", label: "やめる", tone: "quiet", cancel: true }];
  const actions: StepBandAction[] = [];
  const failed = run.steps.find((step) => step.state === "failed");
  const stale = run.steps.find((step) => stepStateOf(step) === "stale");
  const first = failed ?? stale;
  if (first) {
    actions.push({ id: "retry", label: `${quoted(first.name)}からやり直す`, tone: "primary", fromStep: first.index });
  }
  const here = run.steps.find((step) => step.pageId === currentPageId);
  // 開いている段階が、すでに主ボタンになっている段階と同じなら二度出さない
  if (here && here.index !== first?.index) {
    actions.push({ id: "redo-here", label: "この手順を作り直す", tone: first ? "outline" : "primary", fromStep: here.index });
  }
  actions.push({ id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 });
  return actions;
}

/** サイドバーの行に渡す、手順のサブページ（まだ一覧に無い行はここから足す）。 */
export function stepPagesOf(run: StepRun): { id: string; title: string; stepStatus: StepPageStatus | null }[] {
  return run.steps.map((step) => ({ id: step.pageId, title: step.name, stepStatus: step.stepStatus }));
}

/** 終わったときの通知の一言（画面を閉じていた人に出す。本文は入れない）。 */
export function stepDoneMessage(run: StepRun): string | null {
  if (run.state === "succeeded") return `${stepRecipeName(run.recipe)}の手順が終わりました。`;
  if (run.state === "failed") {
    const failed = run.steps.find((step) => step.state === "failed");
    return `${stepRecipeName(run.recipe)}の手順が${failed ? quoted(failed.name) + "で" : ""}失敗しました。`;
  }
  return null;
}
