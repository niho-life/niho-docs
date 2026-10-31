"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { PageSummary } from "@niho/editor-store";
import { RecordingStart, ShellSettingsPage, type RecordingHow, type RecordingNext } from "niho-docs-ui/shell";
import { rememberLastPage } from "@/lib/last-page";
import { isNarrowNow, useEditorFrame } from "./EditorFrame";
import { PageEditor } from "./PageEditor";

/** `/`。デスクトップでは最後に開いたページ（無ければ新しいページ）へ移る。狭い画面では一覧がこの画面なので何もしない。 */
export function HomeRedirect({ lastPageId }: { lastPageId: string | null }) {
  const router = useRouter();
  const { narrow } = useEditorFrame();
  useEffect(() => {
    if (narrow || isNarrowNow()) return;
    router.replace(lastPageId ? `/p/${lastPageId}` : "/p/new");
  }, [narrow, lastPageId, router]);
  return null;
}

/**
 * `/p/{id}`。最後に開いたページとして覚え、題名と保存を一覧へ知らせる。revision は読み込んだときの値（保存の `baseRevision`）、
 * 更新時刻は開いたときに端末の下書きと競合したら帯に出す値。
 */
export function OpenPage({ summary, blocks, revision }: { summary: PageSummary; blocks: unknown[]; revision: number }) {
  const frame = useEditorFrame();
  const { pageOpened } = frame;
  const { id } = summary;
  useEffect(() => {
    rememberLastPage(summary.id);
    pageOpened(summary);
  }, [summary, pageOpened]);
  return (
    <PageEditor
      page={{ id, title: summary.title, blocks, revision, updatedAt: summary.updatedAt, kind: summary.kind, lang: summary.lang }}
      onTitleChange={(value) => frame.pageTitleChanged(id, value)}
      onSaved={() => frame.pageSaved(id)}
    />
  );
}

/**
 * `/p/new`。作ったあと（URL は `/p/{id}`）にもう一度 `/p/new` へ来たら、新しいエディタにする
 * （同じ画面の部品が使い回されても、前に作ったページへ書かない）。
 */
export function NewPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [visit, setVisit] = useState({ pathname, count: 0 });
  if (visit.pathname !== pathname) setVisit({ pathname, count: pathname === "/p/new" ? visit.count + 1 : visit.count });
  // 今のエディタが作ったページ（作ると URL がその `/p/{id}` になる）
  const created = useRef<{ count: number; id: string } | null>(null);
  // それ以外の `/p/{id}` でこの画面が出ているのは、戻る・進むで前に作ったページの履歴へ来たとき。そのページを読み直す
  useEffect(() => {
    const own = created.current?.count === visit.count ? created.current.id : null;
    if (pathname !== "/p/new" && pathname !== `/p/${own}`) router.refresh();
  }, [pathname, visit.count, router]);
  const count = visit.count;
  return <NewPageEditor key={count} onCreated={(id) => (created.current = { count, id })} />;
}

/** 最初の保存でページを作り、URL を `/p/{id}` に替える（エディタは作り直さないので、変換中の文字とカーソルは残る）。 */
function NewPageEditor(props: { onCreated: (id: string) => void }) {
  const frame = useEditorFrame();
  const createdRef = useRef<string | null>(null);
  const titleRef = useRef("");
  // この下書きのエディタがまだ画面にあるか。保存（POST）が終わる前に「録音から」へ移った・別の下書きへ戻ったときは、
  // URL が `/p/new` のままでも、その URL を作ったページの ID へ替えない（pathname だけでは別の画面と区別できない）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  return (
    <PageEditor
      page={{ id: null, title: "", blocks: [], revision: null }}
      onTitleChange={(value) => {
        titleRef.current = value;
        if (createdRef.current) frame.pageTitleChanged(createdRef.current, value);
      }}
      onCreated={(id) => {
        createdRef.current = id;
        props.onCreated(id);
        frame.pageCreated(id, titleRef.current);
        // 保存が終わる前に別の画面へ移っていたら、その画面の URL は替えない
        if (!aliveRef.current || window.location.pathname !== "/p/new") return;
        window.history.replaceState(null, "", `/p/${id}`);
        rememberLastPage(id);
      }}
      onSaved={() => {
        if (createdRef.current) frame.pageSaved(createdRef.current);
      }}
    />
  );
}

/** `/p/new?from=recording`。開始の画面だけ（状態はこの画面の中だけ）。 */
export function RecordingStartScreen() {
  const [how, setHow] = useState<RecordingHow>("mic");
  const [background, setBackground] = useState("");
  const [next, setNext] = useState<RecordingNext>("article");
  return (
    <RecordingStart
      how={how}
      onHow={setHow}
      background={background}
      onBackground={setBackground}
      people={[]}
      terms=""
      next={next}
      onNext={setNext}
      // 開始は #36
      onStart={() => undefined}
    />
  );
}

/** 発信先・役割とつながり・設定。今は題名だけ（中身は #41・#42 とその後）。 */
export function SettingsScreen({ title }: { title: string }) {
  return <ShellSettingsPage title={title}>{null}</ShellSettingsPage>;
}
