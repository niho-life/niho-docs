import { createHash, timingSafeEqual } from "node:crypto";
import { UUID_PATTERN } from "@niho/editor-publish-contract";
import type { ListPosition } from "./source";

/**
 * 一覧の cursor（不透明な文字列）。`v1.<位置>.<印>`。位置は前のページの最後の項目の updatedAt（ミリ秒）と id を base64url にしたもの、
 * 印は位置と、その一覧の範囲（handle と include）の SHA-256 の先頭 22 文字。
 *
 * 位置を書き換えた・別の handle や include の一覧の cursor・形の違うものは、印が合わないので 400 にする。
 * 印は鍵を使わないので、偽造を防ぐものではない（cursor は位置だけで権限を持たない。読めるのはその資格で読める一覧の続きだけ）。
 * 文字は契約の CURSOR_PATTERN（`[A-Za-z0-9._~-]{1,512}`）の内側。
 */

export interface CursorScope {
  readonly handle: string;
  readonly includeUnlisted: boolean;
}

const CURSOR = /^v1\.([A-Za-z0-9_-]{1,96})\.([A-Za-z0-9_-]{22})$/;
const POSITION = /^(0|[1-9][0-9]{0,15})\.([0-9a-f-]{36})$/;
const MAX_TIME_MS = 8.64e15;

function seal(scope: CursorScope, position: string): string {
  return createHash("sha256")
    .update(`niho-editor-public-api-cursor\n${scope.handle}\n${scope.includeUnlisted ? "unlisted" : ""}\n${position}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

export function encodeCursor(after: ListPosition, scope: CursorScope): string {
  const position = Buffer.from(`${Date.parse(after.updatedAt)}.${after.id}`, "utf8").toString("base64url");
  return `v1.${position}.${seal(scope, position)}`;
}

/** 読めない・書き換えた・別の範囲の cursor は null（handler は 400）。 */
export function decodeCursor(value: string, scope: CursorScope): ListPosition | null {
  const match = CURSOR.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const expected = Buffer.from(seal(scope, match[1]), "utf8");
  const actual = Buffer.from(match[2], "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const decoded = POSITION.exec(Buffer.from(match[1], "base64url").toString("utf8"));
  if (!decoded?.[1] || !decoded[2] || !UUID_PATTERN.test(decoded[2])) return null;
  const ms = Number(decoded[1]);
  if (ms > MAX_TIME_MS) return null;
  return { updatedAt: new Date(ms).toISOString(), id: decoded[2] };
}
