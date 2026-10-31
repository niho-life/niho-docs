/**
 * 公開のシート（#39）で画面に出す一言。サーバー（publish-api の応答の message）と画面（シートの URL の欄・選べない設定）の両方が使う。
 * 値（題名・slug・URL）は入れない（入れるのは呼ぶ側が自分で持っている値だけ）。
 */

export const PUBLISH_MESSAGES = {
  notReady: "公開の前に直すところがあります",
  forbiddenRole: "この発信先に出す役割がありません",
  forbiddenConnection: "このサイトとの接続がありません",
  forbiddenSetting: "この発信先では選べない設定があります",
  storageNotCloud: "保存先が NIHO クラウドではないので、公開できません（公開は保存先がクラウドのときだけです）",
  slugLocked: "公開したあとは URL を変えられません",
  slugTaken: "この URL は使われています",
  unavailable: "いまは公開できません",
  failed: "公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください",
  snapshotFailed: "この内容では公開版を作れませんでした。前の公開版と下書きはそのままです",
  stopFailed: "公開をやめられませんでした。もう一度お試しください",
  signedOut: "ログインが切れました。ログインし直してください",
  notFound: "このページが見つかりません",
  forbidden: "この画面からは操作できません",
  network: "通信できませんでした。もう一度お試しください",
  rangeNotOffered: "この発信先では限定公開を選べません",
  extrasNotOffered: "この発信先では選べない「あわせて」があります",
  noField: "この項目を直す欄は、まだ editor にありません",
  unsaved: "保存できていないので公開できません。保存の状態を確かめてから、もう一度お試しください",
  photosUnavailable: "写真の置き場所がまだ設定されていないので、写真のあるページは公開できません",
} as const;

/** slug を使えない理由の一言（editor-publish の SlugError と slug_taken）。 */
export const SLUG_MESSAGES = {
  format: "URL は半角の英小文字・数字と、間のハイフンだけで書いてください",
  length: "URL が長すぎます",
  reserved: "この URL は使えません",
  slug_taken: PUBLISH_MESSAGES.slugTaken,
} as const;

export type SlugMessageKey = keyof typeof SLUG_MESSAGES;

export function slugMessage(error: string | null | undefined): string | null {
  return error && error in SLUG_MESSAGES ? SLUG_MESSAGES[error as SlugMessageKey] : null;
}
