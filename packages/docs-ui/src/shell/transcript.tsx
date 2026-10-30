import { Icon } from "./icons";

export type ShellSegment = {
  id: string;
  who: string;
  /** 話者の色。a＝accent-ink、b＝amber。 */
  tone: "a" | "b";
  time: string;
  text: string;
  /** いま再生している段落。 */
  current?: boolean;
};

export type ShellRecordingProps = {
  segments: ShellSegment[];
  speakers: { name: string; tone: "a" | "b" }[];
  /** 再生位置（例: 05:12 / 14:38）。 */
  position: string;
  editing?: boolean;
  onToggleEdit?: () => void;
  onPlay?: () => void;
  onRenameSpeakers?: () => void;
  onTimestamps?: () => void;
};

/** 録音ブロック（再生・波形・時間）と、話者つきの文字起こし。段落はそのまま直せる。 */
export function ShellRecording({ segments, speakers, position, editing, onToggleEdit, onPlay, onRenameSpeakers, onTimestamps }: ShellRecordingProps) {
  return (
    <div className={`es-rec${editing ? " es-rec--editing" : ""}`}>
      <div className="es-rec-hd">
        <button type="button" className="es-play" aria-label="再生" onClick={onPlay}>
          <Icon name="play" />
        </button>
        <div className="es-wave" aria-hidden="true" />
        <span className="es-time">{position}</span>
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
              <time>{segment.time}</time>
            </div>
            <p contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={`${segment.who} ${segment.time} の文字起こし`}>
              {segment.text}
            </p>
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
        {speakers.map((speaker) => (
          <span key={speaker.name}>
            <i className={`es-tone es-tone--${speaker.tone}`} aria-hidden="true" />
            {speaker.name}
          </span>
        ))}
        <button type="button" onClick={onRenameSpeakers}>
          名前を変える
        </button>
        <button type="button" onClick={onTimestamps}>
          タイムスタンプ
        </button>
      </div>
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
