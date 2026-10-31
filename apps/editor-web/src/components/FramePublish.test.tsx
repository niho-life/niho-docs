// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PUBLISH_NOTICE_MS, PUBLISH_NOTICE_TEXT, PublishNotice } from "./FramePublish";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

async function mount(shown: number, onHide: () => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<PublishNotice shown={shown} onHide={onHide} />));
  return container.querySelector<HTMLElement>("[data-publish-notice]")!;
}

describe("PublishNotice", () => {
  it("keeps an empty polite status region, and says 公開はまだ使えません only while shown, then hides itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onHide = vi.fn();
    const empty = await mount(0, onHide);
    expect(empty.getAttribute("role")).toBe("status");
    expect(empty.getAttribute("aria-live")).toBe("polite");
    expect(empty.textContent).toBe("");
    await act(async () => root!.unmount());
    container!.remove();

    const shown = await mount(1, onHide);
    expect(shown.textContent).toBe(PUBLISH_NOTICE_TEXT);
    expect(onHide).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLISH_NOTICE_MS);
    });
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
