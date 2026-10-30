import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, type SaveState } from "./autosave";

type Patch = { title?: string; blocks?: unknown[] };

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Conflict extends Error {}

  function setup(options: { composing?: () => boolean; fail?: boolean } = {}) {
    const saves: Patch[] = [];
    const states: SaveState[] = [];
    let fail: false | Error = options.fail ? new Error("offline") : false;
    const autosave = createAutosave<Patch>({
      save: async (patch) => {
        saves.push(patch);
        if (fail) throw fail;
      },
      isComposing: options.composing ?? (() => false),
      onState: (state) => states.push(state),
      stopOn: (error) => error instanceof Conflict,
    });
    return { autosave, saves, states, setFail: (value: boolean | Error) => (fail = value === true ? new Error("offline") : value) };
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

  it("sends one save at a time: a change during a save waits for it", async () => {
    let release: () => void = () => undefined;
    const saves: Patch[] = [];
    let active = 0;
    let maxActive = 0;
    const autosave = createAutosave<Patch>({
      save: async (patch) => {
        saves.push(patch);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => (release = resolve));
        active--;
      },
      isComposing: () => false,
      onState: () => undefined,
    });
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    autosave.change({ title: "ab" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves).toEqual([{ title: "a" }]);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([{ title: "a" }, { title: "ab" }]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxActive).toBe(1);
  });

  it("stops saving after a failure that stopOn names, and keeps every later change unsent", async () => {
    const { autosave, saves, states, setFail } = setup();
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe("saved");
    setFail(new Conflict("conflict"));
    autosave.change({ title: "b" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([{ title: "a" }, { title: "b" }]);
    expect(states.at(-1)).toBe("stopped");

    setFail(false);
    const before = states.length;
    autosave.change({ blocks: [] });
    await vi.advanceTimersByTimeAsync(5000);
    await autosave.flush();
    expect(saves).toHaveLength(2);
    expect(states.length).toBe(before);
  });

  it("stops after dispose", async () => {
    const { autosave, saves } = setup();
    autosave.change({ title: "a" });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
  });
});
