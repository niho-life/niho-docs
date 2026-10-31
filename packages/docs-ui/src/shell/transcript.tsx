import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "./icons";

/** 話者の色。a＝accent-ink、b＝amber、c＝blue、d＝brown、e＝ink-mute、f＝red（どれも --ed-* の token から引く）。 */
export type ShellTone = "a" | "b" | "c" | "d" | "e" | "f";
export const SHELL_TONES: readonly ShellTone[] = ["a", "b", "c", "d", "e", "f"];

export type ShellSegment = {
  id: string;
  who: string;
  tone: ShellTone;
  time: string;
  text: string;
  /** いま再生している段落。 */
  current?: boolean;
};

export type ShellSpeaker = {
  name: string;
  tone: ShellTone;
  /** 名前を変える・まとめるときに呼ぶ側へ返す識別子（無ければ name）。 */
  id?: string;
  /** 名前がまだ無い（name は「話者1」のような仮の呼び名）。名前の入力は空から始める。 */
  unnamed?: boolean;
};

/**
 * 話者の操作の結果。false か文字列は失敗（文字列はその場に出す理由）で、フォームを開いたままにする。
 * それ以外（成功・戻り値なし）はフォームを閉じる。
 */
export type ShellSpeakerResult = void | boolean | string | Promise<void | boolean | string>;

export type ShellRecordingProps = {
  segments: ShellSegment[];
  speakers: ShellSpeaker[];
  /** 録音の長さや再生位置（例: 05:12 / 14:38）。無ければ出さない。 */
  position?: string;
  editing?: boolean;
  onToggleEdit?: () => void;
  /** 渡すと再生ボタンと波形を出す。再生できない録音（音声が無い）では渡さない。 */
  onPlay?: () => void;
  /** 段落を直して確定した（フォーカスが外れた・Enter。変換中は確定しない）。文章が変わったときだけ呼ぶ。 */
  onSegmentChange?: (id: string, text: string) => void;
  /** 渡すと話者がボタンになり、その場の小さなフォームで名前を変えられる（空にすると名前を外す）。 */
  onRenameSpeaker?: (id: string, name: string | null) => ShellSpeakerResult;
  /** 渡すと、名前のフォームに「別の話者にまとめる」が出る（確認を 1 回はさむ）。 */
  onMergeSpeakers?: (from: string, into: string) => ShellSpeakerResult;
  /** 名前を変える操作の入口だけを知らせる従来の口（onRenameSpeaker が無いときのボタン）。 */
  onRenameSpeakers?: () => void;
  /** 時刻を出すか（既定は出す）。渡すと「タイムスタンプ」が切り替えボタン（aria-pressed）になる。 */
  showTimestamps?: boolean;
  onTimestamps?: () => void;
};

/** 段落の本文。DOM は呼ぶ側の文章（text）に合わせるが、書いている最中・変換中は触らない。確定は blur と Enter。 */
function SegmentText({ id, text, label, onChange }: { id: string; text: string; label: string; onChange?: (id: string, text: string) => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const state = useRef({ composing: false, dirty: false, blurWaiting: false });
  // React には最初の文章だけを描かせる（書いたあとの DOM を React が書き直して、カーソルや変換を壊さない）。以後は下で合わせる
  const [initial] = useState(text);
  useEffect(() => {
    const element = ref.current;
    if (!element || element === document.activeElement || state.current.composing) return;
    if (element.textContent !== text) element.textContent = text;
    state.current.dirty = false;
  }, [text]);
  const commit = () => {
    const element = ref.current;
    if (!element) return;
    const value = element.textContent ?? "";
    if (!state.current.dirty) {
      // 書き換えていない。フォーカス中に文章が変わっていたら、いまの文章に合わせる
      if (value !== text) element.textContent = text;
      return;
    }
    state.current.dirty = false;
    if (value !== text) onChange?.(id, value);
  };
  return (
    <p
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      onInput={() => {
        state.current.dirty = true;
      }}
      onCompositionStart={() => {
        state.current.composing = true;
      }}
      onCompositionEnd={() => {
        state.current.composing = false;
        // 変換の途中でフォーカスが外れていたら、変換が終わってから確定する
        if (state.current.blurWaiting) {
          state.current.blurWaiting = false;
          commit();
        }
      }}
      onBlur={() => {
        if (state.current.composing) state.current.blurWaiting = true;
        else commit();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLParagraphElement>) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        // 段落は 1 つのまま。Enter は確定、Esc は取り消し
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          // 取り消し: 書いたものを捨て、フォーカスが外れたとき（blur）に元の文章へ戻す
          state.current.dirty = false;
          event.currentTarget.blur();
        }
      }}
      onPaste={(event: ClipboardEvent<HTMLParagraphElement>) => {
        // 書式つきの貼り付けを持ち込まず、文字だけを 1 行で入れる
        event.preventDefault();
        const plain = event.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
        if (typeof document.execCommand === "function") document.execCommand("insertText", false, plain);
      }}
    >
      {initial}
    </p>
  );
}

type Speaker = ShellSpeaker & { id: string };

const SPEAKER_FAILED = "変更できませんでした。もう一度試してください。";

/** 話者を押したときに出る、名前の小さなフォーム（Enter で決める・Esc でやめる）と、別の話者へまとめる確認。 */
function SpeakerForm(props: {
  speaker: Speaker;
  others: Speaker[];
  onRename: (id: string, name: string | null) => ShellSpeakerResult;
  onMerge?: (from: string, into: string) => ShellSpeakerResult;
  onClose: (focusId: string) => void;
}) {
  const { speaker, others } = props;
  const hintId = useId();
  const [value, setValue] = useState(speaker.unnamed ? "" : speaker.name);
  const [into, setInto] = useState(others[0]?.id ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const target = others.find((other) => other.id === into) ?? others[0];

  const attempt = async (run: () => ShellSpeakerResult): Promise<boolean> => {
    setBusy(true);
    setFailure("");
    try {
      const result = await run();
      if (result === false || typeof result === "string") {
        setFailure(typeof result === "string" && result ? result : SPEAKER_FAILED);
        return false;
      }
      return true;
    } catch {
      setFailure(SPEAKER_FAILED);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = value.trim();
    if (next === (speaker.unnamed ? "" : speaker.name)) return props.onClose(speaker.id);
    if (await attempt(() => props.onRename(speaker.id, next === "" ? null : next))) props.onClose(speaker.id);
  };
  const merge = async () => {
    if (busy || !props.onMerge || !target) return;
    if (await attempt(() => props.onMerge!(speaker.id, target.id))) props.onClose(target.id);
  };

  return (
    <form
      className="es-spkform"
      aria-label={`${speaker.name} の名前`}
      onSubmit={rename}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose(speaker.id);
        }
      }}
    >
      <input
        className="es-input"
        type="text"
        value={value}
        maxLength={60}
        autoFocus
        autoComplete="off"
        aria-label={`${speaker.name} の新しい名前`}
        aria-describedby={hintId}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // 変換を決める Enter で送らない
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
        }}
      />
      <button type="submit" className="es-btn es-btn--primary es-btn--sm" disabled={busy}>
        決める
      </button>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => props.onClose(speaker.id)}>
        やめる
      </button>
      <p id={hintId} className="es-spkform-hint">
        Enter で決める・Esc でやめる。空にすると、名前を外して「話者」の番号に戻ります。
      </p>
      {props.onMerge && target && (
        <div className="es-spkform-merge">
          {confirming ? (
            <>
              <p>
                「{speaker.name}」の段落をすべて「{target.name}」にまとめます。元には戻せません。
              </p>
              <button type="button" className="es-btn es-btn--primary es-btn--sm" disabled={busy} onClick={merge}>
                まとめる
              </button>
              <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => setConfirming(false)}>
                やめる
              </button>
            </>
          ) : (
            <>
              <span>この話者を、別の話者にまとめる</span>
              <select aria-label="まとめる先の話者" value={target.id} onChange={(event) => setInto(event.target.value)}>
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
              <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => setConfirming(true)}>
                まとめる
              </button>
            </>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="es-spkform-err">
          {failure}
        </p>
      )}
    </form>
  );
}

/** 録音ブロック（再生・波形・時間）と、話者つきの文字起こし。段落はそのまま直せる。 */
export function ShellRecording({
  segments,
  speakers,
  position,
  editing,
  onToggleEdit,
  onPlay,
  onSegmentChange,
  onRenameSpeaker,
  onMergeSpeakers,
  onRenameSpeakers,
  showTimestamps,
  onTimestamps,
}: ShellRecordingProps) {
  const root = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const withIds: Speaker[] = speakers.map((speaker) => ({ ...speaker, id: speaker.id ?? speaker.name }));
  const open = withIds.find((speaker) => speaker.id === openId);
  const timestamps = showTimestamps !== false;
  // フォームが消えたら、押した話者（まとめたあとは残った話者）へフォーカスを戻す
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    [...(root.current?.querySelectorAll<HTMLElement>("[data-speaker]") ?? [])].find((chip) => chip.dataset.speaker === id)?.focus();
  });
  const close = (focusId: string) => {
    focusAfter.current = focusId;
    setOpenId(null);
  };
  return (
    <div ref={root} className={`es-rec${editing ? " es-rec--editing" : ""}`}>
      <div className="es-rec-hd">
        {onPlay && (
          <>
            <button type="button" className="es-play" aria-label="再生" onClick={onPlay}>
              <Icon name="play" />
            </button>
            <div className="es-wave" aria-hidden="true" />
          </>
        )}
        {position && <span className="es-time">{position}</span>}
        {!onPlay && <span className="es-sp" />}
        <button type="button" className={`es-btn es-btn--sm${editing ? " es-btn--primary" : " es-btn--outline"}`} aria-pressed={editing ?? false} onClick={onToggleEdit}>
          <Icon name={editing ? "check" : "type"} />
          {editing ? "直し終わり" : "文字起こしを直す"}
        </button>
      </div>
      <div className="es-tr">
        {segments.map((segment) => (
          <div key={segment.id} className={`es-seg${segment.current && !editing ? " es-seg--cur" : ""}`}>
            <div className="es-who">
              <span>
                <i className={`es-tone es-tone--${segment.tone}`} aria-hidden="true" />
                {segment.who}
              </span>
              {timestamps && <time>{segment.time}</time>}
            </div>
            <SegmentText id={segment.id} text={segment.text} label={`${segment.who}${timestamps ? ` ${segment.time}` : ""} の文字起こし`} onChange={onSegmentChange} />
          </div>
        ))}
      </div>
      {editing && (
        <div className="es-trhint">
          <Icon name="type" />
          段落をそのまま直せます。話者の名前は下で変えられます。
        </div>
      )}
      <div className="es-speakers">
        {withIds.map((speaker) =>
          onRenameSpeaker ? (
            <button
              key={speaker.id}
              type="button"
              className="es-spk"
              data-speaker={speaker.id}
              aria-label={`${speaker.name} の名前を変える`}
              aria-expanded={openId === speaker.id}
              onClick={() => setOpenId(openId === speaker.id ? null : speaker.id)}
            >
              <i className={`es-tone es-tone--${speaker.tone}`} aria-hidden="true" />
              {speaker.name}
            </button>
          ) : (
            <span key={speaker.id}>
              <i className={`es-tone es-tone--${speaker.tone}`} aria-hidden="true" />
              {speaker.name}
            </span>
          ),
        )}
        {!onRenameSpeaker && (
          <button type="button" onClick={onRenameSpeakers}>
            名前を変える
          </button>
        )}
        <button type="button" aria-pressed={showTimestamps} onClick={onTimestamps}>
          タイムスタンプ
        </button>
      </div>
      {open && onRenameSpeaker && (
        <SpeakerForm key={open.id} speaker={open} others={withIds.filter((speaker) => speaker.id !== open.id)} onRename={onRenameSpeaker} onMerge={onMergeSpeakers} onClose={close} />
      )}
    </div>
  );
}

/** 手順がまだ無い録音の下に出す「この録音から」の入口。 */
export function ShellMakeFrom({
  onArticle,
  onMinutes,
  onSummary,
  onChangeSteps,
}: {
  onArticle?: () => void;
  onMinutes?: () => void;
  onSummary?: () => void;
  onChangeSteps?: () => void;
}) {
  return (
    <div className="es-makefrom" role="group" aria-label="この録音から">
      <span>この録音から</span>
      <button type="button" className="es-btn es-btn--primary es-btn--sm" onClick={onArticle}>
        記事にする
      </button>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={onMinutes}>
        議事録にする
      </button>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={onSummary}>
        要約する
      </button>
      <span className="es-sp" />
      <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={onChangeSteps}>
        手順を変える
      </button>
    </div>
  );
}
