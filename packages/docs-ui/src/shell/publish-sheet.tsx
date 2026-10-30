import { useId } from "react";
import { Icon } from "./icons";
import { ShellSheet } from "./sheet";
import type { ShellDest } from "./types";

/** 公開のシートの「どこに出すか」の1行。url は {host}/{path}/{slug}。 */
export type PublishDestOption = {
  id: ShellDest;
  label: string;
  /** 誰向けか（旅行者向け · 英語）。 */
  who: string;
  url: string;
  /** 出せる理由（ライター・NIHO アカウント・接続済み）。 */
  role: string;
  /** 接続できていない発信先（本人のサイト）は「接続する ›」になり、選べない。 */
  connected: boolean;
};
export type PublishRange = "live" | "unlisted";
export type PublishExtras = { app: boolean; news: boolean; xp: boolean };

export type PublishFormProps = {
  /** 公開中の発信先があるか。あれば見出しは「公開の設定」（更新ありなら「更新を公開」）になり、「公開をやめる」が出る。 */
  current?: { updated?: boolean } | null;
  dests: PublishDestOption[];
  picked?: ShellDest;
  /** 選んだ発信先の条件で足りないもの。1つでもあれば公開は押せない。 */
  missing: { id: string; label: string }[];
  range: PublishRange;
  extras: PublishExtras;
  onPick: (dest: ShellDest) => void;
  /** 未接続の発信先の「接続する ›」。 */
  onConnect?: (dest: ShellDest) => void;
  onAddDest?: () => void;
  onRange: (range: PublishRange) => void;
  onExtra: (key: keyof PublishExtras) => void;
  /** 足りないものの「直す」。 */
  onFix: (id: string) => void;
  onPublish: () => void;
  onUnpublish?: () => void;
  onClose: () => void;
};

export type PublishDoneProps = {
  host: string;
  url: string;
  onView: () => void;
  onCopy?: () => void;
  onClose: () => void;
};

export type AddDestOption = { id: string; label: string; detail: string };
export type AddDestProps = {
  /** 省略すると、モックの 3 つ（公開APIで受け取る・WordPress・Ghost）。 */
  options?: AddDestOption[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export const SHELL_ADD_DEST_OPTIONS: AddDestOption[] = [
  { id: "api", label: "公開APIで受け取る", detail: "どのサイトでも · JSON と Markdown" },
  { id: "wordpress", label: "WordPress", detail: "サイトのURLとアプリケーションパスワード" },
  { id: "ghost", label: "Ghost", detail: "Admin API キー" },
];

export type PublishSheetProps =
  | ({ kind: "publish" } & PublishFormProps)
  | ({ kind: "done" } & PublishDoneProps)
  | ({ kind: "addDest" } & AddDestProps);

/**
 * 公開のシート（モック v6 の SHEET）。kind で 3 種: publish（どこに出すか・範囲・あわせて・足りないもの）／done（公開しました）／addDest（発信先を追加）。
 * 状態はすべて props。EditorShell の overlay に渡す。
 */
export function PublishSheet(props: PublishSheetProps) {
  if (props.kind === "done") return <PublishDone {...props} />;
  if (props.kind === "addDest") return <AddDestSheet {...props} />;
  return <PublishForm {...props} />;
}

function PublishForm(props: PublishFormProps) {
  const destId = useId();
  const rangeId = useId();
  const extraId = useId();
  const needId = useId();
  const noteId = useId();
  const { current, dests, picked, missing, range, extras } = props;
  const chosen = dests.find((dest) => dest.id === picked);
  const blocked = !chosen || !chosen.connected || missing.length > 0;
  const heading = current ? (current.updated ? "更新を公開" : "公開の設定") : "公開";
  const action = current?.updated ? "更新を公開" : current ? "保存" : "公開する";
  const focusId = chosen && chosen.connected ? chosen.id : dests.find((dest) => dest.connected)?.id;
  return (
    <ShellSheet label="公開" onClose={props.onClose}>
      <div className="es-sh-hd">
        <h2>{heading}</h2>
        <span className="es-sp" />
        {current && (
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={props.onUnpublish}>
            公開をやめる
          </button>
        )}
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <h3 id={destId}>どこに出すか</h3>
          <div role="radiogroup" aria-labelledby={destId}>
            {dests.map((dest) =>
              dest.connected ? (
                <button
                  key={dest.id}
                  type="button"
                  role="radio"
                  aria-checked={dest.id === picked}
                  className={`es-dst es-dst--${dest.id}${dest.id === picked ? " es-dst--on" : ""}`}
                  data-autofocus={dest.id === focusId ? "" : undefined}
                  onClick={() => props.onPick(dest.id)}
                >
                  <i aria-hidden="true" />
                  <span>
                    <b>{dest.label}</b>
                    <small>{dest.who}</small>
                    <small>{dest.url}</small>
                  </span>
                  <span className="es-tag-ok">{dest.role}</span>
                </button>
              ) : (
                // 名前は見えている文字そのもの（発信先・説明・URL・「接続する」）。aria-label で別の文に置き換えない（WCAG 2.5.3。#43）
                <button key={dest.id} type="button" className={`es-dst es-dst--${dest.id}`} onClick={() => props.onConnect?.(dest.id)}>
                  <i aria-hidden="true" />
                  <span>
                    <b>{dest.label}</b>
                    <small>{dest.who}</small>
                    <small>{dest.url}</small>
                  </span>
                  <span className="es-tag-no">
                    接続する<span aria-hidden="true"> ›</span>
                  </span>
                </button>
              ),
            )}
          </div>
          <button type="button" className="es-dst es-dst--add" onClick={props.onAddDest}>
            <i aria-hidden="true" />
            <span>
              <b>発信先を追加</b>
            </span>
          </button>
        </div>
        {chosen &&
          (missing.length > 0 ? (
            <div className="es-sh-sec">
              <h3 id={needId}>{chosen.label} に出すには</h3>
              <ul className="es-need" aria-labelledby={needId}>
                {missing.map((item) => (
                  <li key={item.id}>
                    {item.label}
                    <button type="button" aria-label={`${item.label} を直す`} onClick={() => props.onFix(item.id)}>
                      直す
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="es-sh-sec">
              <p className="es-ready">
                <Icon name="check" />
                {chosen.label} の条件はそろっています
              </p>
            </div>
          ))}
        {chosen && chosen.id !== "site" && (
          <div className="es-sh-sec">
            <h3 id={rangeId}>範囲</h3>
            <div role="radiogroup" aria-labelledby={rangeId}>
              <button type="button" role="radio" aria-checked={range === "live"} className={`es-opt${range === "live" ? " es-opt--on" : ""}`} onClick={() => props.onRange("live")}>
                <i aria-hidden="true" />
                公開<small>一覧・検索に出る</small>
              </button>
              <button type="button" role="radio" aria-checked={range === "unlisted"} className={`es-opt${range === "unlisted" ? " es-opt--on" : ""}`} onClick={() => props.onRange("unlisted")}>
                <i aria-hidden="true" />
                限定公開<small>URLを知っている人だけ</small>
              </button>
            </div>
          </div>
        )}
        {chosen && (
          <div className="es-sh-sec">
            <h3 id={extraId}>あわせて</h3>
            <div role="group" aria-labelledby={extraId}>
              <button type="button" role="checkbox" aria-checked={extras.app} className={`es-chk${extras.app ? " es-chk--on" : ""}`} onClick={() => props.onExtra("app")}>
                <i aria-hidden="true" />
                NIHOアプリに載せる
              </button>
              <button type="button" role="checkbox" aria-checked={extras.news} className={`es-chk${extras.news ? " es-chk--on" : ""}`} onClick={() => props.onExtra("news")}>
                <i aria-hidden="true" />
                ニュースレター<small>次号</small>
              </button>
              <button
                type="button"
                role="checkbox"
                aria-checked={extras.xp}
                aria-disabled={chosen.id !== "exp"}
                className={`es-chk${extras.xp ? " es-chk--on" : ""}${chosen.id === "exp" ? "" : " es-chk--off"}`}
                onClick={() => {
                  if (chosen.id === "exp") props.onExtra("xp");
                }}
              >
                <i aria-hidden="true" />
                体験ページに載せる<small>{chosen.id === "exp" ? "関連する体験の末尾" : "NIHO Experience のときだけ"}</small>
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="es-sh-foot">
        {chosen ? (
          !chosen.connected ? (
            <span id={noteId} className="es-sh-note es-sh-left">
              {chosen.label} に接続すると公開できます
            </span>
          ) : missing.length > 0 ? (
            <span id={noteId} className="es-sh-note es-sh-left">
              あと {missing.length} つ
            </span>
          ) : (
            <code id={noteId} className="es-sh-note">
              {chosen.url}
            </code>
          )
        ) : (
          <span id={noteId} className="es-sh-note es-sh-hint">
            発信先を選ぶと条件が出ます
          </span>
        )}
        <span className="es-sh-acts">
          <button type="button" className="es-btn es-btn--quiet" onClick={props.onClose}>
            閉じる
          </button>
          <button type="button" className="es-btn es-btn--primary" disabled={blocked} aria-describedby={noteId} onClick={props.onPublish}>
            {action}
          </button>
        </span>
      </div>
    </ShellSheet>
  );
}

function PublishDone({ host, url, onView, onCopy, onClose }: PublishDoneProps) {
  return (
    <ShellSheet label="公開しました" onClose={onClose}>
      <div className="es-donebox">
        <div className="es-donebox-mk" aria-hidden="true">
          ✓
        </div>
        <h2>{host} に公開しました</h2>
        <code>{url}</code>
      </div>
      <div className="es-sh-foot es-sh-foot--center">
        <button type="button" className="es-btn es-btn--primary" data-autofocus="" onClick={onView}>
          見る
        </button>
        <button type="button" className="es-btn es-btn--outline" onClick={onCopy}>
          リンクをコピー
        </button>
        <button type="button" className="es-btn es-btn--quiet" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}

function AddDestSheet({ options = SHELL_ADD_DEST_OPTIONS, onPick, onClose }: AddDestProps) {
  return (
    <ShellSheet label="発信先を追加" onClose={onClose}>
      <div className="es-sh-hd">
        <h2>発信先を追加</h2>
      </div>
      <div className="es-sh-sec es-sh-sec--list">
        {options.map((option, index) => (
          <button key={option.id} type="button" className="es-dst es-dst--site" data-autofocus={index === 0 ? "" : undefined} onClick={() => onPick(option.id)}>
            <i aria-hidden="true" />
            <span>
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </span>
            <span className="es-tag-no" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
      <div className="es-sh-foot">
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}
