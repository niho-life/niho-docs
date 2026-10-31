/**
 * AI チャットの上限のうち、画面（クライアント）も読むもの。
 * ループ本体（chat.ts）はサーバー専用の anthropic.ts を読むので、画面からは取り込めない。
 */

/** 人の指示の上限（文字）。 */
export const MAX_CHAT_INPUT_CHARS = 2_000;
