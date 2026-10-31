// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeAudioDuration } from "./audio-duration";

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });

/** createElement("audio") をつかまえて、メタデータの読み込みを起こせるようにする。 */
function captureAudio() {
  const original = document.createElement.bind(document);
  const created: HTMLAudioElement[] = [];
  vi.spyOn(document, "createElement").mockImplementation(((name: string) => {
    const element = original(name);
    if (name === "audio") created.push(element as HTMLAudioElement);
    return element;
  }) as typeof document.createElement);
  return created;
}

function stubUrls() {
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL: revoke }));
  return revoke;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeAudioDuration", () => {
  it("is null where blob URLs cannot be made", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: undefined }));
    expect(await probeAudioDuration(blob())).toBeNull();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => {
      throw new Error("no");
    } }));
    expect(await probeAudioDuration(blob())).toBeNull();
  });

  it("reads the duration from the metadata only, then lets the URL go", async () => {
    const revoke = stubUrls();
    const created = captureAudio();
    const pending = probeAudioDuration(blob());
    const audio = created[0]!;
    expect(audio.preload).toBe("metadata");
    expect(audio.getAttribute("src")).toBe("blob:synthetic");
    Object.defineProperty(audio, "duration", { value: 878.4, configurable: true });
    audio.onloadedmetadata?.(new Event("loadedmetadata"));
    expect(await pending).toBe(878.4);
    expect(revoke).toHaveBeenCalledWith("blob:synthetic");
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("is null for an unknown length (Infinity), an error, or no answer in time", async () => {
    stubUrls();
    const created = captureAudio();
    const infinite = probeAudioDuration(blob());
    Object.defineProperty(created[0]!, "duration", { value: Number.POSITIVE_INFINITY, configurable: true });
    created[0]!.onloadedmetadata?.(new Event("loadedmetadata"));
    expect(await infinite).toBeNull();

    const broken = probeAudioDuration(blob());
    created[1]!.onerror?.(new Event("error"));
    expect(await broken).toBeNull();

    vi.useFakeTimers();
    const slow = probeAudioDuration(blob(), { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(await slow).toBeNull();
  });
});
