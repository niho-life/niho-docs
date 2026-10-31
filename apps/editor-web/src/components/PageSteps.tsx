"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PageKind } from "@niho/editor-store";
import { ShellSteps, ShellStepsStart, type ShellStepsAction } from "niho-docs-ui/shell";
import { StepsRequestError, cancelStepRun, getStepRun, isStepRunDone, startStepRun, type StepRun } from "@/lib/steps-client";
import {
  isStepRunActive,
  stepBandActions,
  stepBandNote,
  stepBandSteps,
  stepDoneMessage,
  stepPagesOf,
  stepRecipeName,
  stepStartChoices,
  type StepBandAction,
} from "@/lib/steps-view";
import { useEditorFrame } from "./EditorFrame";

/**
 * 状態を読み直す間隔（ms）。動いている間だけ、だんだん空けながら読む（短い間隔で回さない）。
 * 画面が隠れている間は読まず、戻ってきたら 1 回だけ読み直す。画面を離れたら止める。
 */
const POLL_MS = [4_000, 7_000, 12_000, 20_000, 30_000] as const;

function pollDelay(round: number): number {
  return POLL_MS[Math.min(round, POLL_MS.length - 1)]!;
}

function messageOf(error: unknown): string {
  if (error instanceof StepsRequestError) {
    if (error.status === 401) return "ログインが切れています。もう一度ログインしてください。";
    if (error.error === "run_in_progress") return "いま別の手順が動いています。終わるまで待ってください。";
    if (error.error === "invalid_from_step") return "手前の段階が済んでいないので、ここからは作り直せません。";
    if (error.error === "steps_unavailable" || error.status === 503) return "いま手順を実行できません。しばらくしてからもう一度。";
    if (error.status === 404) return "このページの手順は見つかりませんでした。";
  }
  return "手順の状態を読めませんでした。しばらくしてからもう一度。";
}

/** 許可されているときだけブラウザ通知を出す（設計 §7.2。本文は入れず、終わったことだけ）。 */
function notifyDone(run: StepRun): void {
  const message = stepDoneMessage(run);
  if (message === null || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("NIHO editor", { body: message, tag: `steps-${run.id}` });
  } catch {
    // 通知を出せない環境（権限を取り消された直後など）では黙ってあきらめる
  }
}

/** 始めるときに、まだ聞いていなければ通知の許可を聞く（押した操作の中なので聞いてよい）。 */
function askNotifyPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/**
 * 手順の帯（#37。設計 §7.2）。録音ページと、その手順のサブページで、ページのいちばん上に出る。
 * 録音ページの「この録音から」の入口は、モック v6 と同じく文字起こしの下（`media` の後）に出す。
 *
 * - 状態は親（録音ページ）の id で読む。読むたびにサーバーが前提変更を測り直すので、画面では測らない。
 * - 帯の段階を押すとそのサブページへ移る。失敗した段階・前提が変わった段階からやり直せる（受付 API に `fromStep` を渡すだけ）。
 * - 実行はサーバー（Cloud Tasks の worker）が進めるので、画面を閉じても進む。開き直すと読み直すので帯は最新になる。
 * - 手順に関わらないページ（録音でもサブページでもない）では、帯も入口も出さず `media` と本文をそのまま並べる。
 */
export function PageSteps({
  pageId,
  kind,
  parentId,
  media,
  children,
}: {
  pageId: string;
  kind: PageKind;
  parentId: string | null;
  /** 本文の上に入るもの（録音ページの文字起こし）。 */
  media?: ReactNode;
  /** 本文（PageEditor）。 */
  children: ReactNode;
}) {
  const router = useRouter();
  const { stepPagesChanged } = useEditorFrame();
  // 手順は録音ページを根に持つ。サブページを開いているときは親で読む
  const rootId = kind === "rec" ? pageId : parentId;
  const [run, setRun] = useState<StepRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 読み直しの合図（始めた・やり直した直後にもう一度読む）
  const [tick, setTick] = useState(0);
  // 前に見た run が動いていたか（動いている → 終わったの境目でだけ通知する）
  const wasActive = useRef(false);

  const apply = useCallback(
    (next: StepRun) => {
      setRun(next);
      if (wasActive.current && isStepRunDone(next)) notifyDone(next);
      wasActive.current = isStepRunActive(next);
      if (rootId) stepPagesChanged(rootId, stepPagesOf(next));
    },
    [rootId, stepPagesChanged],
  );

  // 開いたときに読み、動いている間だけ、だんだん間隔を空けて読み直す。隠れている間は読まない
  useEffect(() => {
    if (!rootId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let round = 0;
    const read = async () => {
      timer = null;
      try {
        const latest = await getStepRun(rootId);
        if (cancelled) return;
        setNotice(null);
        if (latest) apply(latest);
        else setRun(null);
        if (!isStepRunActive(latest)) return;
      } catch (error) {
        if (cancelled) return;
        // 読めなかったことは帯の下に出し、間隔を空けてもう一度（ログインが切れていれば止める）
        setNotice(messageOf(error));
        if (error instanceof StepsRequestError && (error.status === 401 || error.status === 404)) return;
      }
      if (document.hidden) return;
      timer = setTimeout(() => void read(), pollDelay(round++));
    };
    // 画面に戻ってきたら読み直す（閉じている間に進んだ分を取り込む）
    const onVisible = () => {
      if (!document.hidden && timer === null) void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rootId, tick, apply]);

  if (!rootId) {
    return (
      <>
        {media}
        {children}
      </>
    );
  }
  const root = rootId;

  const send = async (job: () => Promise<StepRun>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      apply(await job());
      // 積んだ直後の状態を読み直す（間隔の数え直しも兼ねる）
      setTick((value) => value + 1);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const start = (recipe: string, fromStep?: number) => {
    askNotifyPermission();
    void send(() => startStepRun(root, fromStep === undefined ? { recipe } : { recipe, fromStep }));
  };

  const actions: StepBandAction[] = run ? stepBandActions(run, pageId) : [];
  const shellActions: ShellStepsAction[] = actions.map((action) => ({ id: action.id, label: action.label, tone: action.tone, busy }));
  const onAction = (id: string) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action || !run) return;
    if (action.cancel) void send(() => cancelStepRun(root, run.id));
    else if (action.fromStep !== undefined) start(run.recipe, action.fromStep);
  };

  return (
    <>
      {run && (
        <ShellSteps
          band
          title={`${stepRecipeName(run.recipe)}の手順`}
          steps={stepBandSteps(run)}
          currentId={pageId}
          note={notice ?? stepBandNote(run)}
          actions={shellActions}
          onSelect={(stepPageId) => {
            if (stepPageId !== pageId) router.push(`/p/${stepPageId}`);
          }}
          onAction={onAction}
        />
      )}
      {!run && notice && (
        <p className="es-stepband-note" role="status">
          {notice}
        </p>
      )}
      {media}
      {/* 録音ページで、手順が動いていないときの入口（終わったあとは別の手順も始められる） */}
      {kind === "rec" && !isStepRunActive(run) && (
        <ShellStepsStart choices={stepStartChoices()} busy={busy} onPick={(recipe) => start(recipe)} onChangeSteps={() => router.push("/settings")} />
      )}
      {children}
    </>
  );
}
