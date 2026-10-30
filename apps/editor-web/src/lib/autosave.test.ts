import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, type SaveState } from "./autosave";

type Patch = { title?: string; blocks?: unknown[] };

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(options: { composing?: () => boolean; fail?: boolean } = {}) {
    const saves: Patch[] = [];
    const states: SaveState[] = [];
    let fail = options.fail ?? false;
    const autosave = createAutosave<Patch>({
      save: async (patch) => {
        saves.push(patch);
        if (fail) throw new Error("offline");
      },
      isComposing: options.composing ?? (() => false),
      onState: (state) => states.push(state),
    });
    return { autosave, saves, states, setFail: (value: boolean) => (fail = value) };
  }

  it("saves once, one second after the last change, with the merged patch", async () => {
    const { autosave, saves, states } = setup();
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(500);
    autosave.change({ title: "ab" });
    autosave.change({ blocks: [{ type: "paragraph" }] });
    await vi.advanceTimersByTimeAsync(999);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([{ title: "ab", blocks: [{ type: "paragraph" }] }]);
    expect(states.at(-1)).toBe("saved");
  });

  it("does not save while an input method is composing", async () => {
    let composing = true;
    const { autosave, saves } = setup({ composing: () => composing });
    autosave.change({ title: "かん" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves).toEqual([]);
    composing = false;
    autosave.change({ title: "漢字" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([{ title: "漢字" }]);
  });

  it("reports a failure and keeps the unsaved change for the next save", async () => {
    const { autosave, saves, states, setFail } = setup({ fail: true });
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe("error");
    setFail(false);
    autosave.change({ blocks: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves.at(-1)).toEqual({ title: "a", blocks: [] });
    expect(states.at(-1)).toBe("saved");
  });

  it("stops after dispose", async () => {
    const { autosave, saves } = setup();
    autosave.change({ title: "a" });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
  });
});
