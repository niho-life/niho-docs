import type { ReactNode } from "react";

export type EditorShellProps = {
  /** 左の一覧（ShellSidebar）。 */
  sidebar: ReactNode;
  /** ヘッダー（ShellHeader）。 */
  header: ReactNode;
  /** 右のレール（ShellRail）。開いているときだけ渡す。 */
  rail?: ReactNode;
  /** 900px 未満で下端に出る道具の帯（ShellMobileToolbar）。 */
  toolbar?: ReactNode;
  /**
   * 左の一覧を出しているか。デスクトップでは左の列、900px 未満では一覧が全画面（ページとレールは隠れる）。
   */
  sidebarOpen: boolean;
  /** 右のレールを出しているか。デスクトップでは右の列、900px 未満ではレールが全画面（ヘッダーの下）。 */
  railOpen: boolean;
  /** 公開のシートなど、枠の上に重ねるもの（PublishSheet）。.es-root の中に出る。 */
  overlay?: ReactNode;
  /** ページの中央（ShellPage や RecordingStart）。 */
  children: ReactNode;
};

/**
 * editor の枠。ws グリッド（一覧｜ヘッダー＋ページ＋レール）。<900px では、一覧・ページ・レールのどれかひとつを全画面で出す。
 * 状態はすべて props（呼ぶ側が持つ）。DocsHost・通信・保存は持たない。
 * 祖先に data-docs-app-root と data-docs-shared-ui が要る（shell.css は共通 UI の root の中だけに効く）。
 */
export function EditorShell({ sidebar, header, rail, toolbar, sidebarOpen, railOpen, overlay, children }: EditorShellProps) {
  const view = sidebarOpen ? "list" : railOpen && rail ? "rail" : "page";
  return (
    <div className="es-root" data-editor-shell data-sidebar={sidebarOpen ? "open" : "closed"} data-rail={railOpen && rail ? "open" : "closed"} data-view={view}>
      <div className="es-ws">
        {sidebar}
        <div className="es-doc">
          {header}
          <div className="es-dbody">
            <main className="es-canvas">{children}</main>
            {railOpen && rail}
          </div>
          {toolbar}
        </div>
      </div>
      {overlay}
    </div>
  );
}
