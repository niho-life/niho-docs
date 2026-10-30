import { NextResponse, type NextRequest } from "next/server";
import { EDITOR_PATH_HEADER } from "./lib/editor-path";

/**
 * 画面の要求に今の path を header で渡すだけ（認証は読まない）。(editor) の layout が未ログインのときの戻り先に使う。
 * 要求に同じ名前の header があっても上書きする（外から戻り先を差し込ませない。戻り先は layout でも safeReturnTo を通す）。
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(EDITOR_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // `/api`・`/auth`・`/_next` と、拡張子のある file（robots.txt など）には付けない
  matcher: ["/((?!api(?:/|$)|auth(?:/|$)|_next/|.*\\.\\w+$).*)"],
};
