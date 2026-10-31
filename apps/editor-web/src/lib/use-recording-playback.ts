"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordingSegment } from "@niho/editor-store";
import { segmentAt, segmentTimeline } from "./playback";

/** load: 音声を読めない（404・ネットワーク・形式に非対応）/ play: 再生を始められない（自動再生の制限など）。 */
export type PlaybackProblem = "load" | "play";

export type RecordingPlayback = {
  /** `<audio>` に付ける ref。付いたら src を付け、外れたとき（unmount・別のページ）に止めて src を外す。 */
  ref: (node: HTMLAudioElement | null) => (() => void) | undefined;
  /** いまの `<audio>`（再生位置のスライダーが自分で購読する）。 */
  element: HTMLAudioElement | null;
  playing: boolean;
  problem: PlaybackProblem | null;
  /** いま再生している段落の id（段落の位置）。まだ再生していない・最初の段落より前は null。 */
  currentId: string | null;
  /** 再生 ⇄ 一時停止。 */
  toggle: () => void;
  /** その位置（秒）から再生する。 */
  playFrom: (seconds: number) => void;
  /** 位置（秒）を動かす（再生・一時停止はそのまま）。 */
  seekTo: (seconds: number) => void;
  /** 読めなかった音声を、もう一度読み込む。 */
  retry: () => void;
};

/** 中断（pause・load・src の付け替え）で play() が断られたのは失敗ではない。 */
function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * 録音ページの再生（#36 段 3b-2）。`<audio>` の状態（再生中・失敗）と、再生位置から引いた「いま再生している段落」を持つ。
 * - いまの段落は timeupdate（ブラウザがおよそ 4 回／秒）・seeked・play・pause のたびに二分探索で引き、変わったときだけ state を更新する
 *   （段落の欄を描き直すのは段落が移ったときだけ）。
 * - play() の失敗（自動再生の制限など）は握りつぶさず problem=play。中断（AbortError）と、読み込みの失敗（error のほうで load）は除く。
 * - `<audio>` の src はこの hook が付け外しする（JSX の src にしない）: 付いたら src を付け、外れたら（unmount・別のページ・再生できなく
 *   なった）止めて src を外し、読み込みをやめる（裏で鳴り続けない）。React が同じ要素の ref を外して付け直しても（StrictMode・
 *   隠した画面の保持）、付け直したときに src が戻る。
 */
export function useRecordingPlayback(src: string | null, segments: readonly Pick<RecordingSegment, "start">[]): RecordingPlayback {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<PlaybackProblem | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  const timeline = useMemo(() => segmentTimeline(segments), [segments]);

  const ref = useCallback(
    (node: HTMLAudioElement | null) => {
      audioRef.current = node;
      setElement(node);
      if (!node) return undefined;
      if (src !== null && node.getAttribute("src") !== src) node.setAttribute("src", src);
      return () => {
        node.pause();
        node.removeAttribute("src");
        node.load();
        if (audioRef.current === node) audioRef.current = null;
        setElement((current) => (current === node ? null : current));
        setPlaying(false);
        setProblem(null);
        currentRef.current = null;
        setCurrentId(null);
      };
    },
    [src],
  );

  useEffect(() => {
    const node = element;
    if (!node) return undefined;
    const update = () => {
      // まだ再生していない（先頭で止まっている）ときは、どの段落も強調しない
      const started = !node.paused || node.currentTime > 0;
      const id = started ? segmentAt(timeline, node.currentTime) : null;
      if (id === currentRef.current) return;
      currentRef.current = id;
      setCurrentId(id);
    };
    const onPlay = () => {
      setPlaying(true);
      setProblem((current) => (current === "play" ? null : current));
      update();
    };
    const onPause = () => {
      setPlaying(false);
      update();
    };
    const onError = () => {
      // src を外したとき（片付け）の知らせは失敗ではない
      if (!node.getAttribute("src")) return;
      setPlaying(false);
      setProblem("load");
    };
    const onLoaded = () => setProblem((current) => (current === "load" ? null : current));
    const listeners: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["timeupdate", update],
      ["seeked", update],
      ["error", onError],
      ["loadedmetadata", onLoaded],
    ];
    for (const [type, listener] of listeners) node.addEventListener(type, listener);
    setPlaying(!node.paused);
    update();
    return () => {
      for (const [type, listener] of listeners) node.removeEventListener(type, listener);
    };
  }, [element, timeline]);

  const play = useCallback(async (node: HTMLAudioElement) => {
    try {
      await node.play();
    } catch (error) {
      if (isAbort(error) || node.error) return;
      setProblem("play");
    }
  }, []);

  const toggle = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    if (node.paused || node.ended) void play(node);
    else node.pause();
  }, [play]);

  const playFrom = useCallback(
    (seconds: number) => {
      const node = audioRef.current;
      if (!node || !Number.isFinite(seconds) || seconds < 0) return;
      node.currentTime = seconds;
      void play(node);
    },
    [play],
  );

  const seekTo = useCallback((seconds: number) => {
    const node = audioRef.current;
    if (!node || !Number.isFinite(seconds) || seconds < 0) return;
    node.currentTime = seconds;
  }, []);

  const retry = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    setProblem(null);
    node.load();
  }, []);

  return { ref, element, playing, problem, currentId, toggle, playFrom, seekTo, retry };
}
