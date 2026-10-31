// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), narrow: false };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));

import { RecordingStartScreen } from "./RecordingStartScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n<v Takuya>こんにちは\n";

const created = {
  page: { id: PAGE_ID, kind: "rec", title: "dinner", lang: "ja", createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" },
  recording: {
    revision: 1,
    source: "vtt",
    language: "ja",
    engine: "vtt-import",
    durationSec: 4,
    sourceName: "dinner.vtt",
    sourceSha256: null,
    segments: [{ start: 0, end: 4, text: "こんにちは", speaker: 1 }],
    speakerNames: { "1": "Takuya" },
    audio: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  speakers: [{ speaker: 1, name: "Takuya", count: 1 }],
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordingStartScreen />);
  });
}

const fileInput = () => container!.querySelector<HTMLInputElement>('input[type="file"]')!;
const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text))!;
const status = () => container!.querySelector('[role="status"]')?.textContent ?? "";
const alertText = () => container!.querySelector('[role="alert"]')?.textContent ?? "";
const vttFile = (name = "dinner.vtt", text = VTT) => new File([text], name, { type: "text/vtt" });

async function choose(file: File) {
  const input = fileInput();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const start = (label = "文字起こしをはじめる") => act(async () => buttonByText(label).click());
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("RecordingStartScreen", () => {
  it("accepts only .vtt and .vtt text/vtt files in the file picker", async () => {
    await mount();
    expect(fileInput().accept).toBe(".vtt,text/vtt");
    expect(fileInput().hidden).toBe(true);
  });

  it("opens the file picker from the drop area, and shows the chosen file", async () => {
    await mount();
    const open = vi.spyOn(fileInput(), "click");
    await act(async () => buttonByText("音声ファイルをここにドロップ").click());
    expect(open).toHaveBeenCalledTimes(1);
    await choose(vttFile("dinner.vtt"));
    expect(container!.textContent).toContain("dinner.vtt");
    expect(container!.textContent).toContain("別のファイルを選ぶ");
    expect(alertText()).toBe("");
  });

  it("imports the chosen .vtt: posts its name and text once, adds the page to the list, and moves to it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(201, created));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile());
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/recordings/import-vtt");
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "dinner.vtt", vtt: VTT });
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE_ID, "dinner");
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
  });

  it("does not send twice while importing", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile());
    await start();
    await start();
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("取り込んでいます");
    await act(async () => finish(respond(201, created)));
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tells that audio files are not available yet, and keeps nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    for (const name of ["talk.m4a", "talk.mp3", "TALK.WAV"]) {
      await choose(new File(["x"], name, { type: "audio/x" }));
      expect(status()).toContain("音声ファイルの文字起こしは、まだ使えません");
      expect(container!.textContent).not.toContain(name);
    }
    await start();
    expect(alertText()).toBe("取り込む .vtt ファイルを選んでください。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells that the microphone is not available yet", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => buttonByText("録音する").click());
    expect(status()).toContain("マイクでの録音は、まだ使えません");
    await start();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("refuses a file over 4 MiB before sending, and other kinds of file", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.vtt", { type: "text/vtt" }));
    expect(alertText()).toContain("4 MiB");
    expect(container!.textContent).not.toContain("big.vtt");
    await choose(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(alertText()).toContain(".vtt ファイルを選んでください");
    await start();
    expect(fetchMock).not.toHaveBeenCalled();
    // ちょうど 4 MiB は選べる
    await choose(new File([new Uint8Array(4 * 1024 * 1024)], "edge.vtt", { type: "text/vtt" }));
    expect(alertText()).toBe("");
    expect(container!.textContent).toContain("edge.vtt");
  });

  it("takes a dropped .vtt file", async () => {
    await mount();
    const target = container!.querySelector(".es-start")!.parentElement!;
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: { files: File[] } };
    event.dataTransfer = { files: [vttFile("dropped.vtt")] };
    await act(async () => {
      target.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(container!.textContent).toContain("dropped.vtt");
  });

  it("shows a failure in Japanese, keeps the chosen file, and imports when pressed again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(400, { error: "bad_request", reason: "vtt_invalid" }))
      .mockResolvedValueOnce(respond(201, created));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile("broken.vtt"));
    await start();
    await settle();
    expect(alertText()).toContain("読み取れませんでした");
    expect(container!.textContent).toContain("broken.vtt");
    expect(router.push).not.toHaveBeenCalled();
    expect(frame.pageCreated).not.toHaveBeenCalled();
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
    expect(alertText()).toBe("");
  });

  it("keeps the file on a network failure and on a payload that is too large", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(respond(413, { error: "payload_too_large" }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile("a.vtt"));
    await start();
    await settle();
    expect(alertText()).toContain("つながりませんでした");
    await start();
    await settle();
    expect(alertText()).toContain("大きすぎます");
    expect(container!.textContent).toContain("a.vtt");
  });
});
