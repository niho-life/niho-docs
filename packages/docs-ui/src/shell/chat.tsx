import { useId } from "react";
import { Icon } from "./icons";
import type { ShellButtonTone } from "./types";

export type ShellChatAction = { id: string; label: string; tone?: ShellButtonTone };
export type ShellChatMessage =
  | { id: string; who: "me"; text: string }
  | { id: string; who: "ai"; text: string; card?: { title: string; note: string; actions: ShellChatAction[] } };

export type ShellChatProps = {
  messages: ShellChatMessage[];
  /** 録音のページでは「文字起こしはそのまま直せます。」を添える。 */
  recording?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onAction?: (messageId: string, actionId: string) => void;
};

/** 「AIと作る」の相談。やりたいことを書くと、AI の提案（手順・ページで見る提案）が会話に出る。 */
export function ShellChat({ messages, recording, value, onChange, onSend, onAction }: ShellChatProps) {
  const input = useId();
  return (
    <div className="es-chat">
      <div className="es-thread" role="log" aria-label="AI との会話" aria-live="polite">
        <div className="es-msg es-msg--ai">
          <span className="es-mk">
            <Icon name="spark" />
          </span>
          <div className="es-bb">
            このページで何をしますか。やりたいことを書いてください。
            {recording && (
              <>
                <br />
                文字起こしはそのまま直せます。
              </>
            )}
          </div>
        </div>
        {messages.map((message) =>
          message.who === "me" ? (
            <div key={message.id} className="es-msg es-msg--me">
              <div className="es-bb">{message.text}</div>
            </div>
          ) : (
            <div key={message.id} className="es-msg es-msg--ai">
              <span className="es-mk">
                <Icon name="spark" />
              </span>
              <div className="es-bb">
                {message.text}
                {message.card && (
                  <div className="es-card">
                    <b>{message.card.title}</b>
                    <small>{message.card.note}</small>
                    <div className="es-acts">
                      {message.card.actions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className={`es-btn es-btn--${action.tone ?? "primary"} es-btn--sm`}
                          onClick={() => onAction?.(message.id, action.id)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ),
        )}
      </div>
      <form
        className="es-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="es-composer-row">
          <Icon name="spark" />
          <input id={input} type="text" placeholder="直したいこと・作りたいもの…" aria-label="AI に相談" value={value} onChange={(event) => onChange(event.target.value)} />
          <button type="submit" className="es-ib es-ib--accent" aria-label="送る">
            <Icon name="up" />
          </button>
        </div>
      </form>
    </div>
  );
}
