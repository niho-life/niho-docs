/*
 * editor の枠（shell）の表示用の型。モック v6（#48）の画面状態を props で描くための形だけを持つ。
 * 保存・通信・DocsHost は持たない（状態は呼ぶ側が持つ）。
 */

/** 公開先。exp＝NIHO Experience、niho＝NIHO、site＝本人のサイト。 */
export type ShellDest = "exp" | "niho" | "site";
export type ShellLang = "ja" | "en";
/** ページの種類。step は録音から作った手順のサブページ。 */
export type ShellPageKind = "note" | "rec" | "step" | "article";
/** 状態の丸。private＝自分だけ、published＝公開中、updated＝更新あり、limited＝限定公開、stopped＝公開をやめた。 */
export type ShellStatusState = "private" | "published" | "updated" | "limited" | "stopped";
export type ShellStepState = "done" | "run" | "wait";
/** 主ボタンは面と文字をセット（--ed-primary-bg / --ed-primary-ink）。outline は白地の縁、quiet は面なし。 */
export type ShellButtonTone = "primary" | "outline" | "quiet";

export type ShellMenuItem = {
  id: string;
  label: string;
  icon?: ShellIconName;
  /** 右に小さく添える補足（例: 文字起こし）。 */
  hint?: string;
  /** 右の数のバッジ（例: 未処理の招待）。 */
  badge?: string;
  danger?: boolean;
  /** いま開いているページ（設定系のページでメニューに現在地を示す）。 */
  current?: boolean;
};

/** 一覧の1行。2行目（sub）は公開先・録音・作成中のときだけ持つ。 */
export type ShellListItem = {
  id: string;
  /** 空なら「無題」と薄く出す。 */
  title: string;
  /** 更新の時刻（「たった今」「昨日」「10月24日」）。 */
  when: string;
  /** 録音から作ったサブページ（親の下に少し下げる）。 */
  child?: boolean;
  sub?: { text: string; dest?: ShellDest };
};

export type ShellPublication = {
  dest: ShellDest;
  range: "live" | "unlisted" | "stopped";
  /** 公開したあとに直した内容があり、まだ読者に出ていない。 */
  updated?: boolean;
  /** 公開先の URL（host/path/slug）。 */
  url: string;
};

export type ShellIconName =
  | "plus"
  | "search"
  | "panel"
  | "side"
  | "more"
  | "lock"
  | "globe"
  | "mic"
  | "spark"
  | "img"
  | "list"
  | "link"
  | "eye"
  | "back"
  | "ext"
  | "ship"
  | "people"
  | "gear"
  | "play"
  | "doc"
  | "cal"
  | "type"
  | "h"
  | "minus"
  | "up"
  | "pin"
  | "phone"
  | "mail"
  | "check"
  | "trash";
