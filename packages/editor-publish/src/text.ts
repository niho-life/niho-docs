/** Text helpers shared by the converter, readiness and snapshot. No values are ever logged. */

// Line breaks and tabs become spaces; every other control character (and lone surrogates) is removed,
// because the contract rejects them in any published text.
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const OTHER_CONTROLS = /[\u0000-\u001f\u007f-\u009f]|\p{Cs}/gu;

export function cleanText(text: string): string {
  return text.replace(WHITESPACE_CONTROLS, " ").replace(OTHER_CONTROLS, "");
}

/** A single-line field: cleaned and trimmed; blank becomes null. Non-strings become null. */
export function cleanLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = cleanText(value).trim();
  return text === "" ? null : text;
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** `[CONFIRM: …]` written in plain text. */
export const CONFIRM_MARKER = /\[CONFIRM:([^\]]*)\]/g;

export function hasConfirmMarker(text: string | null): boolean {
  if (text === null) return false;
  CONFIRM_MARKER.lastIndex = 0;
  const found = CONFIRM_MARKER.test(text);
  CONFIRM_MARKER.lastIndex = 0;
  return found;
}
