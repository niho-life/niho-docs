// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_TONES, ShellRecording, type ShellRecordingProps, type ShellSegment } from "./index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

const SEGMENTS: ShellSegment[] = [
  { id: "s1", who: "Takuya", tone: "a", time: "00:12", text: "最初は、泊まりに来た人と一緒にご飯を作るだけでした。" },
  { id: "s2", who: "Mika", tone: "b", time: "00:41", text: "それが今の形になったのはいつ頃ですか。" },
];
const SPEAKERS = [
  { id: "1", name: "Takuya", tone: "a" as const },
  { id: "2", name: "Mika", tone: "b" as const },
  { id: "3", name: "話者3", tone: "c" as const, unnamed: true },
];

const paragraph = (host: HTMLElement, index = 0) => host.querySelectorAll<HTMLElement>(".es-seg p")[index]!;
const chip = (host: HTMLElement, name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name} の名前を変える"]`)!;
const buttonByText = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;

/** jsdom は contenteditable を focus できない対象にするので、tabindex を付けてから focus する。 */
function focusOn(element: HTMLElement) {
  element.tabIndex = -1;
  act(() => element.focus());
}
function type(element: HTMLElement, text: string) {
  act(() => {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = (element: HTMLElement) => act(() => element.blur());
const key = (element: Element, name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
const compose = (element: Element, type: "compositionstart" | "compositionend") => act(() => element.dispatchEvent(new Event(type, { bubbles: true })));

describe("ShellRecording: 段落を直す", () => {
  it("書き換えてフォーカスが外れたとき、変わった段落だけ onSegmentChange を呼ぶ", () => {
    const onSegmentChange = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={onSegmentChange} />);
    const first = paragraph(host);
    focusOn(first);
    type(first, "最初は、泊まりに来た人と一緒に朝ごはんを作っていました。");
    expect(onSegmentChange).not.toHaveBeenCalled();
    blur(first);
    expect(onSegmentChange).toHaveBeenCalledTimes(1);
    expect(onSegmentChange).toHaveBeenCalledWith("s1", "最初は、泊まりに来た人と一緒に朝ごはんを作っていました。");
  });

  it("触っただけ・元の文章に戻しただけでは呼ばない", () => {
    const onSegmentChange = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={onSegmentChange} />);
    const first = paragraph(host);
    focusOn(first);
    blur(first);
    focusOn(first);
    type(first, "ちがう");
    type(first, SEGMENTS[0]!.text);
    blur(first);
    expect(onSegmentChange).not.toHaveBeenCalled();
  });

  it("変換中は確定しない。変換が終わってから 1 回だけ確定する", () => {
    const onSegmentChange = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={onSegmentChange} />);
    const first = paragraph(host);
    focusOn(first);
    compose(first, "compositionstart");
    type(first, "さいしょは");
    blur(first);
    expect(onSegmentChange).not.toHaveBeenCalled();
    compose(first, "compositionend");
    expect(onSegmentChange).toHaveBeenCalledTimes(1);
    expect(onSegmentChange).toHaveBeenCalledWith("s1", "さいしょは");
  });

  it("変換中の Enter は確定せず、変換が終わったあとの Enter で確定する", () => {
    const onSegmentChange = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={onSegmentChange} />);
    const first = paragraph(host);
    focusOn(first);
    compose(first, "compositionstart");
    type(first, "ひらがな");
    key(first, "Enter", { isComposing: true });
    expect(onSegmentChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
    compose(first, "compositionend");
    key(first, "Enter");
    expect(onSegmentChange).toHaveBeenCalledWith("s1", "ひらがな");
    expect(document.activeElement).not.toBe(first);
  });

  it("Esc で書き換えを取り消して元の文章に戻す", () => {
    const onSegmentChange = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={onSegmentChange} />);
    const first = paragraph(host);
    focusOn(first);
    type(first, "やめる");
    key(first, "Escape");
    expect(onSegmentChange).not.toHaveBeenCalled();
    expect(first.textContent).toBe(SEGMENTS[0]!.text);
  });

  it("呼ぶ側が文章を替えると DOM も替わる。書いている最中の段落は替えない", () => {
    function Harness({ text }: { text: string }) {
      return <ShellRecording segments={[{ ...SEGMENTS[0]!, text }, SEGMENTS[1]!]} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={() => undefined} />;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Harness text="最初の文章" />));
    expect(paragraph(host).textContent).toBe("最初の文章");
    act(() => root.render(<Harness text="最新の文章" />));
    expect(paragraph(host).textContent).toBe("最新の文章");
    focusOn(paragraph(host));
    type(paragraph(host), "書いている途中");
    act(() => root.render(<Harness text="さらに新しい文章" />));
    expect(paragraph(host).textContent).toBe("書いている途中");
  });

  it("貼り付けは書式を持ち込まず、文字だけを 1 行で入れる", () => {
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onSegmentChange={() => undefined} />);
    const insert = vi.fn(() => true);
    (document as unknown as { execCommand: typeof insert }).execCommand = insert;
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: (type: string) => string } };
    event.clipboardData = { getData: (type) => (type === "text/plain" ? "一行目\n  二行目" : "<b>x</b>") };
    act(() => {
      paragraph(host).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(insert).toHaveBeenCalledWith("insertText", false, "一行目 二行目");
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
});

describe("ShellRecording: 表示", () => {
  it("onPlay が無いと再生ボタンと波形を出さず、あれば出す", () => {
    const without = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} position="14:38" />);
    expect(without).not.toContain('aria-label="再生"');
    expect(without).not.toContain("es-wave");
    expect(without).toContain("14:38");
    const withPlay = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} position="05:12 / 14:38" onPlay={() => undefined} />);
    expect(withPlay).toContain('aria-label="再生"');
    expect(withPlay).toContain("es-wave");
  });

  it("showTimestamps=false で時刻を隠し、ボタンは押した状態を伝える。渡さなければ今までどおり", () => {
    const shown = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} showTimestamps onTimestamps={() => undefined} />);
    expect(shown).toContain("<time>00:12</time>");
    expect(shown).toContain('aria-label="Takuya 00:12 の文字起こし"');
    expect(shown).toMatch(/aria-pressed="true"[^>]*>タイムスタンプ/);
    const hidden = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} showTimestamps={false} onTimestamps={() => undefined} />);
    expect(hidden).not.toContain("<time>");
    expect(hidden).toContain('aria-label="Takuya の文字起こし"');
    expect(hidden).toMatch(/aria-pressed="false"[^>]*>タイムスタンプ/);
    const legacy = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} />);
    expect(legacy).toContain("<time>00:12</time>");
    expect(legacy).not.toMatch(/aria-pressed="[a-z]+"[^>]*>タイムスタンプ/);
  });

  it("時刻の無い段落（time が空）は、時刻の欄も名前の中の時刻も出さない", () => {
    const html = renderToStaticMarkup(<ShellRecording segments={[{ ...SEGMENTS[0]!, time: "" }, SEGMENTS[1]!]} speakers={SPEAKERS} />);
    expect(html).toContain('aria-label="Takuya の文字起こし"');
    expect(html.match(/<time>/g)).toHaveLength(1);
  });

  it("話者は 6 色まで。どの色も class になる", () => {
    expect(SHELL_TONES).toEqual(["a", "b", "c", "d", "e", "f"]);
    const html = renderToStaticMarkup(
      <ShellRecording
        segments={SHELL_TONES.map((tone, index) => ({ id: tone, who: `話者${index + 1}`, tone, time: "00:00", text: "あ" }))}
        speakers={SHELL_TONES.map((tone, index) => ({ name: `話者${index + 1}`, tone }))}
      />,
    );
    for (const tone of SHELL_TONES) expect(html).toContain(`es-tone--${tone}`);
  });

  it("従来の呼び出し（onRenameSpeakers）は、話者を押せない名札と「名前を変える」ボタンのまま", () => {
    const onRenameSpeakers = vi.fn();
    const host = mount(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS.slice(0, 2)} onRenameSpeakers={onRenameSpeakers} />);
    expect(host.querySelector(".es-spk")).toBeNull();
    act(() => buttonByText(host, "名前を変える").click());
    expect(onRenameSpeakers).toHaveBeenCalledTimes(1);
  });
});

describe("ShellRecording: 再生（#36 段 3b-2）", () => {
  it("playing で再生ボタンが「一時停止」になり、押すと onPlay。seek を渡すと波形の代わりに出す（渡さなければ今までどおり）", () => {
    const onPlay = vi.fn();
    const host = mount(
      <ShellRecording
        segments={SEGMENTS}
        speakers={SPEAKERS}
        onPlay={onPlay}
        playing
        seek={
          <span className="es-seek">
            <input type="range" aria-label="再生位置" defaultValue={0} />
          </span>
        }
      />,
    );
    const button = host.querySelector<HTMLButtonElement>(".es-play")!;
    expect(button.getAttribute("aria-label")).toBe("一時停止");
    expect(host.querySelector(".es-wave")).toBeNull();
    expect(host.querySelector('.es-rec-hd input[aria-label="再生位置"]')).not.toBeNull();
    act(() => button.click());
    expect(onPlay).toHaveBeenCalledTimes(1);

    const paused = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} onPlay={() => undefined} playing={false} />);
    expect(paused).toContain('aria-label="再生"');
    expect(paused).toContain("es-wave");
    // onPlay が無ければ、playing・seek を渡しても再生の部品は出さない
    const none = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} playing seek={<input aria-label="再生位置" />} />);
    expect(none).not.toContain("es-play");
    expect(none).not.toContain("再生位置");
  });

  it("onPlayFrom を渡すと時刻がボタンになり、押すとその段落の id を返す。時刻の無い段落・時刻を隠したときはボタンを出さない", () => {
    const onPlayFrom = vi.fn();
    const segments: ShellSegment[] = [...SEGMENTS, { id: "s3", who: "Mika", tone: "b", time: "", text: "時刻の無い段落。" }];
    const host = mount(<ShellRecording segments={segments} speakers={SPEAKERS} onPlayFrom={onPlayFrom} />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button.es-at")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["00:12 から再生", "00:41 から再生"]);
    // 時刻は <time> のまま（読み上げの名前と段落の名前は今までどおり）
    expect(buttons.map((button) => button.querySelector("time")?.textContent)).toEqual(["00:12", "00:41"]);
    expect(paragraph(host, 1).getAttribute("aria-label")).toBe("Mika 00:41 の文字起こし");
    act(() => buttons[1]!.click());
    expect(onPlayFrom).toHaveBeenCalledWith("s2");

    const hidden = renderToStaticMarkup(<ShellRecording segments={segments} speakers={SPEAKERS} onPlayFrom={onPlayFrom} showTimestamps={false} />);
    expect(hidden).not.toContain("es-at");
    const legacy = renderToStaticMarkup(<ShellRecording segments={SEGMENTS} speakers={SPEAKERS} />);
    expect(legacy).not.toContain("es-at");
    expect(legacy).toContain("<time>00:12</time>");
  });

  it("再生中の段落（current）を強調し、直している最中は強調しない。強調が移っても、書いている最中の段落の文章は替えない", () => {
    function Harness({ current, editing }: { current: string | null; editing?: boolean }) {
      return (
        <ShellRecording
          segments={SEGMENTS.map((segment) => ({ ...segment, current: segment.id === current }))}
          speakers={SPEAKERS.slice(0, 2)}
          editing={editing}
          onSegmentChange={() => undefined}
          onPlayFrom={() => undefined}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const highlighted = () => [...host.querySelectorAll(".es-seg")].map((row) => row.classList.contains("es-seg--cur"));
    act(() => root.render(<Harness current="s1" />));
    expect(highlighted()).toEqual([true, false]);
    focusOn(paragraph(host, 1));
    type(paragraph(host, 1), "書いている途中の文章");
    const element = paragraph(host, 1);
    act(() => root.render(<Harness current="s2" />));
    expect(highlighted()).toEqual([false, true]);
    // 同じ要素のまま、書いた文章もフォーカスも残る
    expect(paragraph(host, 1)).toBe(element);
    expect(element.textContent).toBe("書いている途中の文章");
    expect(document.activeElement).toBe(element);
    act(() => root.render(<Harness current="s2" editing />));
    expect(highlighted()).toEqual([false, false]);
  });

  it("呼ぶ側が描くたびに関数を作り直しても、段落の確定と時刻の押下は最新の関数に届く（行は memo）", () => {
    const calls: string[] = [];
    function Harness({ version }: { version: number }) {
      return (
        <ShellRecording
          segments={SEGMENTS.map((segment) => ({ ...segment }))}
          speakers={SPEAKERS.slice(0, 2)}
          onSegmentChange={(id, text) => calls.push(`change@${version}:${id}:${text}`)}
          onPlayFrom={(id) => calls.push(`play@${version}:${id}`)}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Harness version={1} />));
    act(() => root.render(<Harness version={2} />));
    focusOn(paragraph(host, 0));
    type(paragraph(host, 0), "直した文章");
    blur(paragraph(host, 0));
    act(() => host.querySelectorAll<HTMLButtonElement>("button.es-at")[1]!.click());
    expect(calls).toEqual(["change@2:s1:直した文章", "play@2:s2"]);
  });
});

describe("ShellRecording: 話者の名前とまとめる", () => {
  function Harness(props: Partial<ShellRecordingProps>) {
    return <ShellRecording segments={SEGMENTS} speakers={SPEAKERS} onRenameSpeaker={() => undefined} onMergeSpeakers={() => undefined} {...props} />;
  }
  const nameInput = (host: HTMLElement) => host.querySelector<HTMLInputElement>(".es-spkform input")!;
  function enter(input: HTMLInputElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const submit = (host: HTMLElement) => act(() => host.querySelector<HTMLFormElement>(".es-spkform")!.requestSubmit());

  it("話者を押すと小さなフォームが開き、名前を入れて Enter（送信）で onRenameSpeaker を呼んで閉じる", async () => {
    const onRenameSpeaker = vi.fn();
    const host = mount(<Harness onRenameSpeaker={onRenameSpeaker} />);
    expect(host.querySelector(".es-spkform")).toBeNull();
    act(() => chip(host, "Mika").click());
    expect(chip(host, "Mika").getAttribute("aria-expanded")).toBe("true");
    const input = nameInput(host);
    expect(input.getAttribute("aria-label")).toBe("Mika の新しい名前");
    expect(input.value).toBe("Mika");
    enter(input, "  Mika Sato ");
    await act(async () => submit(host));
    expect(onRenameSpeaker).toHaveBeenCalledWith("2", "Mika Sato");
    expect(host.querySelector(".es-spkform")).toBeNull();
    expect(document.activeElement).toBe(chip(host, "Mika"));
  });

  it("名前の無い話者は空から始め、空のまま決めると何も呼ばずに閉じる。名前を消して決めると null（名前を外す）", async () => {
    const onRenameSpeaker = vi.fn();
    const host = mount(<Harness onRenameSpeaker={onRenameSpeaker} />);
    act(() => chip(host, "話者3").click());
    expect(nameInput(host).value).toBe("");
    await act(async () => submit(host));
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    expect(host.querySelector(".es-spkform")).toBeNull();
    act(() => chip(host, "Takuya").click());
    enter(nameInput(host), "");
    await act(async () => submit(host));
    expect(onRenameSpeaker).toHaveBeenCalledWith("1", null);
  });

  it("Esc で取り消す。呼ばないで閉じ、話者へフォーカスが戻る", () => {
    const onRenameSpeaker = vi.fn();
    const host = mount(<Harness onRenameSpeaker={onRenameSpeaker} />);
    act(() => chip(host, "Takuya").click());
    enter(nameInput(host), "変えかけ");
    key(nameInput(host), "Escape");
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    expect(host.querySelector(".es-spkform")).toBeNull();
    expect(document.activeElement).toBe(chip(host, "Takuya"));
  });

  it("失敗（文字列か false）はフォームを開いたまま、理由を role=alert で出す", async () => {
    const onRenameSpeaker = vi.fn(async () => "この名前は使えません。");
    const host = mount(<Harness onRenameSpeaker={onRenameSpeaker} />);
    act(() => chip(host, "Takuya").click());
    enter(nameInput(host), "話者9");
    await act(async () => submit(host));
    expect(host.querySelector(".es-spkform")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("この名前は使えません。");
    expect(nameInput(host).value).toBe("話者9");
  });

  it("まとめる: 先を選んで押すと確認が出て、もう一度押すと onMergeSpeakers（元に戻せないことを伝える）", async () => {
    const onMergeSpeakers = vi.fn();
    const host = mount(<Harness onMergeSpeakers={onMergeSpeakers} />);
    act(() => chip(host, "話者3").click());
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="まとめる先の話者"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Takuya", "Mika"]);
    act(() => buttonByText(host, "まとめる").click());
    expect(onMergeSpeakers).not.toHaveBeenCalled();
    expect(host.querySelector(".es-spkform-merge")?.textContent).toContain("「話者3」の段落をすべて「Takuya」にまとめます。元には戻せません。");
    await act(async () => buttonByText(host, "まとめる").click());
    expect(onMergeSpeakers).toHaveBeenCalledWith("3", "1");
    expect(host.querySelector(".es-spkform")).toBeNull();
  });

  it("話者が 1 人だけなら「まとめる」は出ない。onMergeSpeakers が無くても出ない", () => {
    const one = mount(<Harness speakers={SPEAKERS.slice(0, 1)} />);
    act(() => chip(one, "Takuya").click());
    expect(one.querySelector(".es-spkform-merge")).toBeNull();
    const none = mount(<Harness onMergeSpeakers={undefined} />);
    act(() => chip(none, "Mika").click());
    expect(none.querySelector(".es-spkform-merge")).toBeNull();
  });

  it("名前を決めた結果を呼ぶ側の state で反映できる（全段落の表示名が替わる）", async () => {
    function Stateful() {
      const [name, setName] = useState("Mika");
      return (
        <ShellRecording
          segments={SEGMENTS.map((segment) => (segment.id === "s2" ? { ...segment, who: name } : segment))}
          speakers={[SPEAKERS[0]!, { ...SPEAKERS[1]!, name }]}
          onRenameSpeaker={(_id, next) => setName(next ?? "話者2")}
        />
      );
    }
    const host = mount(<Stateful />);
    act(() => chip(host, "Mika").click());
    enter(nameInput(host), "Mika Sato");
    await act(async () => submit(host));
    expect(host.querySelector(".es-seg:nth-child(2) .es-who span")?.textContent).toBe("Mika Sato");
    expect(chip(host, "Mika Sato").textContent).toBe("Mika Sato");
  });
});
