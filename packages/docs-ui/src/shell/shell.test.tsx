import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EditorShell,
  RecordingStart,
  ShellAddRow,
  ShellBody,
  ShellChat,
  ShellHeader,
  ShellMakeFrom,
  ShellMobileToolbar,
  ShellPage,
  ShellPageSettings,
  ShellProposal,
  ShellRail,
  ShellRailSection,
  ShellRecording,
  ShellSelectionBar,
  ShellSidebar,
  ShellSteps,
  ShellTools,
  StatusDot,
  shellAccountItems,
  shellMoreItems,
  shellPublishButton,
  shellStatus,
  type ShellListItem,
} from "./index";

const noop = () => undefined;

const ITEMS: ShellListItem[] = [
  { id: "a", title: "10月30日（木）", when: "たった今" },
  { id: "b", title: "Takuya さんと話したこと", when: "昨日", sub: { text: "録音" } },
  { id: "c", title: "文字起こし修正", when: "昨日", child: true },
  { id: "d", title: "Riding the Enoden", when: "昨日", sub: { text: "NIHO Experience", dest: "exp" } },
  { id: "e", title: "", when: "たった今" },
];

function sidebar(over: Partial<Parameters<typeof ShellSidebar>[0]> = {}) {
  return (
    <ShellSidebar
      items={ITEMS}
      currentId="a"
      onSelect={noop}
      onCollapse={noop}
      newMenu={{ open: false, onToggle: noop, onClose: noop, onPick: noop }}
      search={{ open: false, value: "", onOpen: noop, onClose: noop, onChange: noop }}
      me={{ name: "Mika Sato", caption: "mika@example.com", initial: "M", badge: 1, open: false, items: shellAccountItems(1), onToggle: noop, onClose: noop, onSelect: noop }}
      {...over}
    />
  );
}

function header(over: Partial<Parameters<typeof ShellHeader>[0]> = {}) {
  return (
    <ShellHeader
      title="10月30日（木）"
      showListButton
      onToggleList={noop}
      tools={<ShellTools />}
      status={shellStatus(null)}
      publish={{ label: "公開", tone: "outline" }}
      railOpen={false}
      onToggleRail={noop}
      more={{ open: false, items: shellMoreItems(), onToggle: noop, onClose: noop, onSelect: noop }}
      {...over}
    />
  );
}

/** ボタンはすべて、aria-label か見える文字を持つ。 */
function unlabeledButtons(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs ?? "") && (inner ?? "").replace(/<[^>]*>/g, "").trim() === "")
    .map(([whole]) => whole.slice(0, 80));
}

describe("EditorShell", () => {
  const html = renderToStaticMarkup(
    <EditorShell sidebar={sidebar()} header={header()} toolbar={<ShellMobileToolbar />} sidebarOpen railOpen={false}>
      <ShellPage kind="note" lang="ja" title="10月30日（木）">
        <ShellBody blocks={[{ type: "p", text: "朝、北鎌倉まで歩いた。" }]} />
      </ShellPage>
    </EditorShell>,
  );

  it("root は es-root と data-editor-shell を持ち、状態を data 属性で出す", () => {
    expect(html).toMatch(/^<div class="es-root" data-editor-shell="true" data-sidebar="open" data-rail="closed" data-view="list">/);
  });

  it("900px 未満の全画面の切り替えは props から決まる（一覧 > レール > ページ）", () => {
    const view = (sidebarOpen: boolean, railOpen: boolean, rail?: boolean) =>
      renderToStaticMarkup(
        <EditorShell sidebar={null} header={null} rail={rail ? <ShellRail>x</ShellRail> : undefined} sidebarOpen={sidebarOpen} railOpen={railOpen}>
          x
        </EditorShell>,
      ).match(/data-view="(\w+)"/)?.[1];
    expect(view(true, true, true)).toBe("list");
    expect(view(false, true, true)).toBe("rail");
    expect(view(false, true, false)).toBe("page");
    expect(view(false, false, true)).toBe("page");
  });

  it("ボタンはすべて名前（aria-label か文字）を持つ", () => {
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("主な部品の landmark: aside・nav>ul・header・main（main は skip link の移動先なので id と tabindex=-1 を持つ）", () => {
    expect(html).toContain('<aside class="es-sb" aria-label="ページ">');
    expect(html).toMatch(/<nav class="es-sb-list" aria-label="ページの一覧"><ul>/);
    expect(html).toContain('<header class="es-dt">');
    expect(html).toContain('<main id="es-main" class="es-canvas" tabindex="-1">');
    // 下端の道具の帯は、名前つきの region（ヘッダー・本文の外に出るので、ランドマークに入れる。#43）
    expect(html).toContain('<div class="es-mtb" role="region" aria-label="道具の帯">');
  });

  it("最初のフォーカス先は「本文へ移動」（skip link。移動先は main）", () => {
    const first = /<(a|button|input|textarea|select)\b[^>]*>/.exec(html);
    expect(first?.[0]).toBe('<a class="es-skip" href="#es-main">');
    expect(html.indexOf("本文へ移動")).toBeLessThan(html.indexOf('<div class="es-ws">'));
  });

  it("landmark の名前は重複しない（同じ役割のものが 2 つあるときは、名前で見分けられる）", () => {
    const withRail = renderToStaticMarkup(
      <EditorShell sidebar={sidebar()} header={header()} rail={<ShellRail>x</ShellRail>} toolbar={<ShellMobileToolbar />} sidebarOpen railOpen>
        x
      </EditorShell>,
    );
    const asides = [...withRail.matchAll(/<aside\b[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(asides).toEqual(["ページ", "このページの設定と AI"]);
    expect(new Set(asides).size).toBe(asides.length);
    expect([...withRail.matchAll(/<main\b/g)]).toHaveLength(1);
    expect([...withRail.matchAll(/<header\b/g)]).toHaveLength(1);
  });
});

describe("ShellSidebar", () => {
  const html = renderToStaticMarkup(sidebar());

  it("絞り込み（すべて／公開中／録音）を持たない", () => {
    expect(html).not.toContain("すべて");
    expect(html).not.toContain("公開中");
    expect(html).not.toMatch(/role="tab(list)?"/);
    // 「録音」は一覧の2行目の文字だけ（絞り込みのボタンではない）
    expect([...html.matchAll(/録音/g)]).toHaveLength(1);
  });

  it("上は検索アイコンと＋だけ。開閉ボタンは＋の右隣", () => {
    const top = html.slice(html.indexOf('class="es-sb-top"'), html.indexOf("<nav"));
    const labels = [...top.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["探す", "新しいページ", "一覧をしまう"]);
  });

  it("1行は題名＋時刻。2行目は公開先・録音・作成中のときだけ。無題は薄く「無題」", () => {
    expect([...html.matchAll(/class="es-di-sub"/g)]).toHaveLength(2);
    expect(html).toContain("es-di es-di--on es-di--one");
    expect(html).toContain('<i class="es-dest es-dest--exp" aria-hidden="true"></i>NIHO Experience');
    expect(html).toContain('<span class="es-di-t es-di-t--untitled">無題</span>');
    expect(html).toContain("es-di es-di--child es-di--one");
  });

  it("現在のページは aria-current=page、下は本人の行ひとつ（招待の数つき）", () => {
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="未処理の招待 1 件"');
    expect([...html.matchAll(/class="es-sb-me/g)]).toHaveLength(1);
    expect(shellAccountItems(1).map((item) => item.label)).toEqual(["発信先", "役割とつながり", "設定", "ログアウト"]);
    expect(shellAccountItems(0).every((item) => !item.badge)).toBe(true);
  });

  it("listEnd は一覧の <ul> の直後（<nav> の中）に出る。渡さなければ何も足さない", () => {
    const withEnd = renderToStaticMarkup(sidebar({ listEnd: <div data-list-end="" /> }));
    expect(withEnd).toContain('</ul><div data-list-end=""></div></nav>');
    expect(html).toContain("</ul></nav>");
  });

  it("検索を開くと入力に替わる（aria-label つき）", () => {
    const open = renderToStaticMarkup(sidebar({ search: { open: true, value: "", onOpen: noop, onClose: noop, onChange: noop } }));
    expect(open).toContain('role="search"');
    expect(open).toContain('aria-label="ページを探す"');
  });
});

describe("ShellHeader", () => {
  it("1段: 一覧 → 道具 → 状態 → 公開 → レール → … の順で並ぶ", () => {
    const html = renderToStaticMarkup(header());
    expect([...html.matchAll(/<header\b/g)]).toHaveLength(1);
    const order = ["一覧を出す", "ブロックを足す", "録音", "ページの状態", ">公開<", "このページの設定と AI", 'aria-label="その他"'].map((needle) => html.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("道具: ＋ テキスト B I リンク 見出し 箇条書き 画像 録音", () => {
    const html = renderToStaticMarkup(<ShellTools />);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    // 「行の種類」は見えている文字（いまの行の種類）から始める（WCAG 2.5.3。#43）
    expect(labels).toEqual(["書式とブロック", "ブロックを足す", "テキスト、行の種類", "太字", "斜体", "リンク", "見出し", "箇条書き", "画像", "録音"]);
    expect(html).toContain('role="toolbar"');
    // 行の種類が変わると、見える文字と名前の両方が変わる
    const heading = renderToStaticMarkup(<ShellTools textType="見出し" />);
    expect(heading).toContain('aria-label="見出し、行の種類" aria-haspopup="menu">見出し <span aria-hidden="true">▾</span>');
  });

  it("状態は丸ひとつ。吹き出しはキーボードのフォーカスでも読め、aria-live で伝わる", () => {
    const html = renderToStaticMarkup(<StatusDot state="published" tip="公開中 · niho.life/article/gomi · 保存済み" />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/tabindex="0"/);
    expect(html).toMatch(/aria-describedby="([^"]+)"/);
    const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${id}" role="tooltip"`);
    expect(html).toContain("公開中 · niho.life/article/gomi · 保存済み");
    // 画面に言葉を置かない: 丸（i）だけで、状態の文字は吹き出しの中だけ
    expect(html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/, "").replace(/<[^>]*>/g, "")).toBe("");
  });

  it("状態の文言とボタン（モック v6 と同じ）", () => {
    const pub = (over: object) => ({ dest: "exp" as const, range: "live" as const, url: "experience.niho.life/guides/x", ...over });
    expect(shellStatus(null)).toEqual({ state: "private", tip: "自分だけ · 保存済み" });
    expect(shellStatus(pub({ range: "stopped" }))).toEqual({ state: "stopped", tip: "公開をやめた · 保存済み" });
    expect(shellStatus(pub({ updated: true })).state).toBe("updated");
    expect(shellStatus(pub({ range: "unlisted" })).tip).toBe("限定公開 · URL を知っている人だけ · 保存済み");
    expect(shellStatus(pub({}))).toEqual({ state: "published", tip: "公開中 · experience.niho.life/guides/x · 保存済み" });
    expect(shellPublishButton({ pub: null })).toEqual({ label: "公開", tone: "outline", menu: false });
    expect(shellPublishButton({ pub: null, isArticle: true }).tone).toBe("primary");
    expect(shellPublishButton({ pub: null, planned: true }).tone).toBe("primary");
    expect(shellPublishButton({ pub: pub({ updated: true }) })).toEqual({ label: "更新を公開", tone: "primary", menu: false });
    expect(shellPublishButton({ pub: pub({}) })).toEqual({ label: "公開中", tone: "quiet", menu: true });
    expect(shellPublishButton({ pub: pub({ range: "stopped" }), isArticle: true }).label).toBe("公開");
  });

  it("録音からの画面は状態・公開のかわりに trailing を出す", () => {
    const html = renderToStaticMarkup(<ShellHeader title="録音から" trailing={<button type="button">やめる</button>} />);
    expect(html).toContain("やめる");
    expect(html).not.toContain("es-st-wrap");
    expect(html).not.toContain("es-pubbtn");
  });
});

describe("ShellRail", () => {
  const html = renderToStaticMarkup(
    <ShellRail>
      <ShellRailSection title="手順" icon="spark" summary="記事本文" open={false} onToggle={noop}>
        <ShellSteps
          steps={[
            { id: "a", label: "文字起こし", state: "done" },
            { id: "b", label: "文字起こし修正", state: "run" },
            { id: "c", label: "記事本文", state: "wait" },
          ]}
          currentId="b"
          onRedo={noop}
        />
      </ShellRailSection>
      <ShellRailSection title="ページ設定" summary="自分だけ" open onToggle={noop}>
        <p>x</p>
      </ShellRailSection>
      <ShellRailSection title="AIと作る" icon="spark" fill>
        <p>chat</p>
      </ShellRailSection>
    </ShellRail>,
  );

  it("開閉する節は button の aria-expanded、閉じていれば一言（summary）を見出しに出す", () => {
    expect(html).toContain('id="es-rail"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?手順[\s\S]*?記事本文/);
    expect(html).toMatch(/aria-expanded="true"[^>]*>ページ設定/);
    expect(html).not.toMatch(/aria-expanded="true"[^>]*>ページ設定[\s\S]*?自分だけ<\/span><span class="es-cv"/);
  });

  it("節の見出しは h2（ページの h1 の次の段。h3 から始めない。#43）", () => {
    expect([...html.matchAll(/<h(\d) class="es-ch-h">/g)].map((m) => m[1])).toEqual(["2", "2", "2"]);
    expect(html).not.toMatch(/<h[34]\b/);
  });

  it("ページ設定の中の小見出しは h3（レールの節 h2 の下）", () => {
    const settings = renderToStaticMarkup(
      <ShellRailSection title="ページ設定" open onToggle={noop}>
        <ShellPageSettings lang="ja" author={{ name: "Mika Sato", title: "ライター", initial: "M" }} info={[{ label: "作成", value: "昨日" }]} />
      </ShellRailSection>,
    );
    const levels = [...settings.matchAll(/<h(\d)\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    expect(levels.slice(1).length).toBeGreaterThan(0);
    expect(levels.slice(1).every((level) => level === 3)).toBe(true);
  });

  it("「AIと作る」は開閉せず残りの高さを使う（fill）", () => {
    expect(html).toContain("es-cd es-cd--open es-cd--fill");
    expect(html).toContain('<span class="es-ch es-ch--static">');
    expect(html).toMatch(/class="es-cb" hidden=""/);
  });

  it("手順は 済み・作成中・待機 と、いまの手順に aria-current=step", () => {
    expect(html).toContain("済み");
    expect(html).toContain("作成中");
    expect(html).toContain("待機");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("この手順を作り直す");
  });
});

describe("ページの部品", () => {
  it("ShellPage: 記事はカバー・kicker・リード、メモは題名とメタだけ", () => {
    const article = renderToStaticMarkup(
      <ShellPage kind="article" lang="en" title="Riding the Enoden" cover="set" kicker="Travel" lead="Lead." meta={[{ author: "Mika Sato", initial: "M", text: "昨日" }]}>
        <ShellBody blocks={[{ type: "p", text: "Body" }, { type: "h2", text: "H" }, { type: "ul", items: ["a"] }]} />
      </ShellPage>,
    );
    // 画像（role=img）と「変更」ボタンは兄弟。role=img の中にボタンを入れない（nested-interactive。#43）
    expect(article).toContain(
      '<div class="es-cover"><span class="es-cover-ph" role="img" aria-label="カバー写真（仮の面）"></span><button type="button" class="es-chg">変更</button></div>',
    );
    expect(article).not.toMatch(/role="img"[^>]*>(?:(?!<\/span>)[\s\S])*<button/);
    expect(article).toContain(">TRAVEL<");
    expect(article).toContain('class="es-ld" data-ph="Lead"');
    expect(article).not.toContain("url(");
    const memo = renderToStaticMarkup(<ShellPage kind="note" lang="ja" title="10月30日（木）" meta={[{ text: "木曜日" }]} />);
    expect(memo).toContain("es-tt es-ja");
    expect(memo).not.toContain("es-tt--journal");
    expect(memo).not.toContain("es-ld");
    expect(memo).not.toContain("es-cover");
    // 題名はページの h1。空のときは見えている「無題」を名前にする（空の見出しにしない）
    expect(memo).toMatch(/<h1 class="es-tt es-ja" data-ph="無題" spellcheck="false">10月30日（木）<\/h1>/);
    const untitled = renderToStaticMarkup(<ShellPage kind="note" lang="ja" title="" />);
    expect(untitled).toContain('<h1 class="es-tt es-ja" data-ph="無題" aria-label="無題"');
  });

  it("選んだ文字の上の書式の帯（静的）は toolbar で、ボタンに名前がある", () => {
    const html = renderToStaticMarkup(
      <ShellBody blocks={[{ type: "p", text: [{ kind: "sel", text: "選んだ文字" }, "つづき"] }]} />,
    );
    expect(html).toContain('<span class="es-selwrap"><span class="es-sel">選んだ文字</span><span class="es-selbar" role="toolbar" aria-label="書式">');
    expect(unlabeledButtons(html)).toEqual([]);
    expect(renderToStaticMarkup(<ShellSelectionBar />)).toContain("AI に頼む");
  });

  it("録音: 文字起こしと、手順がまだ無いときの入口", () => {
    const html = renderToStaticMarkup(
      <>
        <ShellRecording
          segments={[{ id: "1", who: "Takuya", tone: "a", time: "00:12", text: "最初は…", current: true }]}
          speakers={[{ name: "Takuya", tone: "a" }]}
          position="05:12 / 14:38"
        />
        <ShellMakeFrom />
      </>,
    );
    expect(html).toContain("文字起こしを直す");
    expect(html).toContain("es-seg es-seg--cur");
    expect(html).toContain("名前を変える");
    expect(html).toContain("記事にする");
    expect(html).toContain("議事録にする");
    expect(html).toContain("要約する");
    expect(html).toContain("手順を変える");
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("提案: 消す文は del、足す文は ins。採用した段落には採用の操作が出ない", () => {
    const html = renderToStaticMarkup(
      <ShellProposal
        label="整える"
        blocks={[
          { id: "1", parts: ["a", { del: "b" }, { ins: "c" }] },
          { id: "2", parts: ["x"], done: true, note: "変更なし" },
        ]}
      />,
    );
    expect(html).toContain("<del>b</del>");
    expect(html).toContain("<ins>c</ins>");
    expect([...html.matchAll(/>採用</g)]).toHaveLength(1);
    expect(html).toContain("変更なし");
    expect(html).toContain("すべて採用");
  });

  it("＋の行: 閉じていれば aria-label つきの＋、開けばブロックの一覧（menu）", () => {
    expect(renderToStaticMarkup(<ShellAddRow hint menuOpen={false} onToggle={noop} onPick={noop} onClose={noop} />)).toContain("「/」でも出せます");
    const open = renderToStaticMarkup(<ShellAddRow menuOpen onToggle={noop} onPick={noop} onClose={noop} />);
    expect(open).toContain('role="menu" aria-label="ブロックを足す"');
    for (const label of ["テキスト", "見出し", "箇条書き", "画像", "録音", "音声ファイル", "区切り線"]) expect(open).toContain(label);
  });

  it("AIと作る: 会話は log（aria-live）、送るに名前がある", () => {
    const html = renderToStaticMarkup(
      <ShellChat
        recording
        value=""
        onChange={noop}
        onSend={noop}
        messages={[
          { id: "1", who: "me", text: "整える" },
          { id: "2", who: "ai", text: "まとめました", card: { title: "提案", note: "n", actions: [{ id: "v", label: "ページで見る" }] } },
        ]}
      />,
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("文字起こしはそのまま直せます。");
    expect(html).toContain('aria-label="AI に相談"');
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("ページ設定: 公開中は発信先と URL、更新ありなら一言、予定なら足りないもの", () => {
    const base = { lang: "en" as const, author: { name: "Mika Sato", title: "Writer", initial: "M" }, info: [{ label: "作成", value: "2026-10-28" }] };
    const published = renderToStaticMarkup(
      <ShellPageSettings {...base} destination={{ dest: "exp", label: "NIHO Experience", url: "experience.niho.life/guides/x", updated: true }} category={{ options: ["Food", "Travel"], value: "Travel", onPick: noop }} related={{ items: [{ id: "d", title: "Dinner", by: "NIHO kamakura" }] }} />,
    );
    expect(published).toContain("experience.niho.life/guides/x");
    expect(published).toContain("直した内容はまだ読者に出ていません");
    expect(published).toContain("1/3");
    expect(published).toContain('aria-pressed="true"');
    const planned = renderToStaticMarkup(
      <ShellPageSettings {...base} destination={{ dest: "niho", label: "NIHO", url: "niho.life/article/x", planned: true, missing: [{ id: "cover", label: "カバー写真" }] }} />,
    );
    expect(planned).toContain("NIHO に公開する予定");
    expect(planned).toContain("カバー写真");
    expect(unlabeledButtons(published + planned)).toEqual([]);
  });

  it("録音から: 録音する／ドロップ／背景情報・登場人物・固有名詞／このあと（既存の語彙）", () => {
    const html = renderToStaticMarkup(
      <RecordingStart how="mic" onHow={noop} background="" onBackground={noop} people={[{ name: "Takuya", tone: "a" }]} terms="北鎌倉 · 円覚寺" next="article" onNext={noop} onStart={noop} />,
    );
    for (const text of ["録音する", "音声ファイルをここにドロップ", ".m4a .mp3 .wav、文字起こし済みの .vtt も", "背景情報", "任意", "登場人物", "話者の名前になります", "固有名詞", "設定から引き継いでいます", "このあと", "記事にする", "議事録にする", "文字起こしだけ", "録音をはじめる", "文字起こしは NIHO クラウドで行います"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-checked="true"');
    expect(unlabeledButtons(html)).toEqual([]);
    // 見出しは h1（録音から）→ h2（背景情報・登場人物・固有名詞・このあと）。h4 へ飛ばない（#43）
    expect([...html.matchAll(/<h(\d)\b/g)].map((m) => m[1])).toEqual(["1", "2", "2", "2", "2"]);
    const file = renderToStaticMarkup(
      <RecordingStart how="file" onHow={noop} file={{ name: "dinner-1029.m4a", detail: "14:38 · 32 MB" }} background="" onBackground={noop} people={[]} terms="" next="none" onNext={noop} onStart={noop} />,
    );
    expect(file).toContain("dinner-1029.m4a");
    expect(file).toContain("文字起こしをはじめる");
  });
});
