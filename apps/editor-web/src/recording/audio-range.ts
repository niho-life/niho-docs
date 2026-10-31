/**
 * 録音の再生（#36 段 3b-2）の `Range` header の読み方（純粋な関数）。RFC 9110 §14 のバイト範囲のうち、範囲 1 つだけを扱う。
 *
 * - 無い → 全体（200）。
 * - `bytes=a-b`（終わりが全体を超えたら全体の終わりで切る）・`bytes=a-`（終わりまで）・`bytes=-n`（終わりの n バイト。全体より
 *   大きければ先頭から）→ 範囲（206）。単位の名前は大文字・小文字を区別しない。
 * - 範囲が 2 つ以上・形が不正（数字でない・終わりが始まりより前・空）・始まりが全体の大きさ以上・`-0`・空の音声への範囲 → 416。
 * - `bytes` 以外の単位（形は正しい）→ 無視して全体（RFC 9110 §14.2 は知らない単位の Range を無視するよう求める）。
 * 数は 10 進の文字列のまま比べず Number にする。全体の大きさは安全な整数（2 GiB を超えても壊れない）で、桁の多すぎる数は
 * 全体より大きい数として扱われる（始まりなら 416、終わりなら全体の終わりで切る、末尾の長さなら全体）。
 */

export type AudioRange = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/** RFC 9110 の token（単位の名前）。 */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SPEC = /^(\d*)-(\d*)$/;

const UNSATISFIABLE: AudioRange = { kind: "unsatisfiable" };
const FULL: AudioRange = { kind: "full" };

/**
 * `Range` header の値（無ければ null）と全体の大きさ（バイト。0 以上の安全な整数）から、返す範囲を決める。
 * 全体の大きさが整数でなければ TypeError（呼び出し側の誤り）。
 */
export function resolveAudioRange(header: string | null, totalBytes: number): AudioRange {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new TypeError("audio-range: totalBytes must be a non-negative safe integer");
  if (header === null) return FULL;
  const value = header.trim();
  const equals = value.indexOf("=");
  if (equals <= 0) return UNSATISFIABLE;
  const unit = value.slice(0, equals);
  if (!TOKEN.test(unit)) return UNSATISFIABLE;
  if (unit.toLowerCase() !== "bytes") return FULL;
  const set = value.slice(equals + 1);
  // 範囲は 1 つだけ（複数の範囲の multipart は返さない）
  if (set.includes(",")) return UNSATISFIABLE;
  const match = SPEC.exec(set.trim());
  if (!match) return UNSATISFIABLE;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return UNSATISFIABLE;
  if (first === "") {
    // 終わりの n バイト。n = 0 と空の音声は満たせない
    const suffix = Number(last);
    if (suffix === 0 || totalBytes === 0) return UNSATISFIABLE;
    return { kind: "partial", start: Math.max(0, totalBytes - suffix), end: totalBytes - 1 };
  }
  const start = Number(first);
  const end = last === "" ? Number.POSITIVE_INFINITY : Number(last);
  if (end < start) return UNSATISFIABLE;
  if (start >= totalBytes) return UNSATISFIABLE;
  return { kind: "partial", start, end: Math.min(end, totalBytes - 1) };
}

/** 206 の `Content-Range`（`bytes a-b/total`）。 */
export function contentRange(start: number, end: number, totalBytes: number): string {
  return `bytes ${start}-${end}/${totalBytes}`;
}

/** 416 の `Content-Range`（範囲の代わりに `*` を置き、全体の大きさだけを伝える形）。 */
export function unsatisfiedContentRange(totalBytes: number): string {
  return `bytes */${totalBytes}`;
}
