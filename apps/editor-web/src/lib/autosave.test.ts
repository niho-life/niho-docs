import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, RETRY_DELAYS_MS, type SaveContext, type SaveFailure, type SaveState } from "./autosave";

type Patch = { title?: string; blocks?: unknown[] };

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class Conflict extends Error {}
  class Offline extends TypeError {}
  class SignedOut extends Error {}

  const classify = (error: unknown): SaveFailure =>
    error instanceof Conflict ? "stopped" : error instanceof Offline ? "offline" : error instanceof SignedOut ? "signedOut" : "error";

  function setup(options: { composing?: () => boolean; fail?: boolean } = {}) {
    const saves: Patch[] = [];
    const contexts: SaveContext[] = [];
    const times: number[] = [];
    const states: SaveState[] = [];
    const saved: boolean[] = [];
    let fail: false | Error = options.fail ? new Error("server") : false;
    const online = new Set<() => void>();
    const autosave = createAutosave<Patch>({
      save: async (patch, context) => {
        saves.push(patch);
        contexts.push(context);
        times.push(Date.now());
        if (fail) throw fail;
      },
      isComposing: options.composing ?? (() => false),
      onState: (state) => states.push(state),
      onSaved: (idle) => saved.push(idle),
      classify,
      subscribeOnline: (listener) => {
        online.add(listener);
        return () => online.delete(listener);
      },
    });
    return {
      autosave,
      saves,
      contexts,
      times,
      states,
      saved,
      goOnline: () => online.forEach((listener) => listener()),
      onlineListeners: () => online.size,
      setFail: (value: boolean | Error) => (fail = value === true ? new Error("server") : value),
    };
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

  it("reads a lazy value only when it sends, once per save, and never per change", async () => {
    const { autosave, saves } = setup();
    const read = vi.fn(() => [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }]);
    for (let index = 0; index < 50; index++) autosave.change({ blocks: read });
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(saves).toEqual([{ blocks: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }] }]);
  });

  it("does not save while an input method is composing", async () => {
    let composing = true;
    const { autosave, saves } = setup({ composing: () => composing });
    autosave.change({ title: "かん" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves).toEqual([]);
    await autosave.flush();
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

  it("keeps the failed value under a newer lazy change and resolves the newer one on the next save", async () => {
    const { autosave, saves, setFail } = setup({ fail: true });
    autosave.change({ title: "a", blocks: () => ["old"] });
    await vi.advanceTimersByTimeAsync(1000);
    setFail(false);
    autosave.change({ blocks: () => ["new"] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([
      { title: "a", blocks: ["old"] },
      { title: "a", blocks: ["new"] },
    ]);
  });

  it("retries a server failure with backoff 5s, 10s, 20s, 40s, then every 60s", async () => {
    const { autosave, times, states } = setup({ fail: true });
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000 + 5000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(gaps).toEqual([...RETRY_DELAYS_MS, 60_000]);
    expect(RETRY_DELAYS_MS).toEqual([5000, 10_000, 20_000, 40_000, 60_000]);
    expect(states.at(-1)).toBe("error");
  });

  it("goes offline on a network failure, and saves as soon as the browser is back online", async () => {
    const { autosave, saves, states, setFail, goOnline } = setup();
    setFail(new Offline("Failed to fetch"));
    autosave.change({ title: "電車の中" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe("offline");
    expect(saves).toHaveLength(1);

    setFail(false);
    goOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([{ title: "電車の中" }, { title: "電車の中" }]);
    expect(states.at(-1)).toBe("saved");
    // 戻ったあとは送り直さない
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saves).toHaveLength(2);
  });

  it("keeps showing offline while the user types, and sends a new change after one second without waiting for the backoff", async () => {
    const { autosave, saves, states, setFail } = setup();
    setFail(new Offline("Failed to fetch"));
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toHaveLength(2);
    const before = states.length;
    autosave.change({ title: "ab" });
    expect(states.length).toBe(before);
    expect(states.at(-1)).toBe("offline");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(3);
    expect(saves.at(-1)).toEqual({ title: "ab" });
  });

  it("does not resend after a sign-out (no timer, no online event), but tries again on new input", async () => {
    const { autosave, saves, states, setFail, goOnline } = setup();
    setFail(new SignedOut("401"));
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe("signedOut");
    goOnline();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(saves).toHaveLength(1);

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

  it("keeps retries serial: an online event or a flush during a save does not start a second one", async () => {
    let release: (error?: Error) => void = () => undefined;
    let active = 0;
    let maxActive = 0;
    const listeners: Array<() => void> = [];
    const states: SaveState[] = [];
    const autosave = createAutosave<Patch>({
      save: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve, reject) => (release = (error) => (error ? reject(error) : resolve())));
        } finally {
          active--;
        }
      },
      isComposing: () => false,
      onState: (state) => states.push(state),
      classify,
      subscribeOnline: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    });
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    release(new Offline("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(active).toBe(1);
    listeners.forEach((listener) => listener());
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxActive).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("saved");
    expect(maxActive).toBe(1);
  });

  it("stops saving after a failure classified as stopped, keeps every later change unsent, and resumes on request", async () => {
    const { autosave, saves, states, setFail, goOnline } = setup();
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
    goOnline();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await autosave.flush();
    expect(saves).toHaveLength(2);
    expect(states.length).toBe(before);

    autosave.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves.at(-1)).toEqual({ title: "b", blocks: [] });
    expect(states.at(-1)).toBe("saved");
  });

  it("can be stopped before any save, and keeps the changes for resume", async () => {
    const { autosave, saves, states } = setup();
    autosave.stop();
    expect(states.at(-1)).toBe("stopped");
    autosave.change({ title: "下書き" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
    autosave.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([{ title: "下書き" }]);
  });

  it("flushes at once on request, with keepalive when asked", async () => {
    const { autosave, saves, contexts } = setup();
    autosave.change({ title: "a" });
    await autosave.flush({ keepalive: true });
    expect(saves).toEqual([{ title: "a" }]);
    expect(contexts).toEqual([{ keepalive: true }]);
    autosave.change({ title: "ab" });
    await autosave.flush();
    expect(contexts.at(-1)).toEqual({ keepalive: false });
  });

  it("tells whether a save left the page idle (nothing typed during it)", async () => {
    let release: () => void = () => undefined;
    const saved: boolean[] = [];
    const autosave = createAutosave<Patch>({
      save: () => new Promise<void>((resolve) => (release = resolve)),
      isComposing: () => false,
      onState: () => undefined,
      onSaved: (idle) => saved.push(idle),
    });
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    autosave.change({ title: "ab" });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual([false]);
    expect(autosave.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual([false, true]);
    expect(autosave.hasPending()).toBe(false);
  });

  it("on close, sends what is pending right after the save in flight, once, and never retries", async () => {
    let release: (error?: Error) => void = () => undefined;
    const saves: Patch[] = [];
    const autosave = createAutosave<Patch>({
      save: (patch) => {
        saves.push(patch);
        return new Promise<void>((resolve, reject) => (release = (error) => (error ? reject(error) : resolve())));
      },
      isComposing: () => false,
      onState: () => undefined,
      classify,
    });
    let reads = 0;
    autosave.change({ title: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    autosave.change({ blocks: () => [`read ${++reads}`] });
    autosave.close();
    // 閉じた時点で値を取っておく（エディタはこのあと無くなる）
    expect(reads).toBe(1);
    expect(saves).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([{ title: "a" }, { blocks: ["read 1"] }]);
    release(new Offline("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(saves).toHaveLength(2);
  });

  describe("settle", () => {
    it("sends what is pending at once and resolves saved once it is on the server", async () => {
      const { autosave, saves } = setup();
      autosave.change({ title: "a" });
      let state: SaveState | null = null;
      void autosave.settle().then((value) => (state = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toEqual([{ title: "a" }]);
      expect(state).toBe("saved");
      expect(autosave.hasPending()).toBe(false);
      // 何も無ければ送らずにすぐ
      await expect(autosave.settle()).resolves.toBe("saved");
      expect(saves).toHaveLength(1);
    });

    it("waits for the save in flight and then sends what was typed during it, before resolving", async () => {
      let release: () => void = () => undefined;
      const saves: Patch[] = [];
      const autosave = createAutosave<Patch>({
        save: async (patch) => {
          saves.push(patch);
          await new Promise<void>((resolve) => (release = resolve));
        },
        isComposing: () => false,
        onState: () => undefined,
      });
      autosave.change({ title: "a" });
      await vi.advanceTimersByTimeAsync(1000);
      autosave.change({ title: "ab" });
      let state: SaveState | null = null;
      void autosave.settle().then((value) => (state = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toEqual([{ title: "a" }]);
      release();
      // 1 秒の時計を待たずに続きを送る
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toEqual([{ title: "a" }, { title: "ab" }]);
      expect(state).toBeNull();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(state).toBe("saved");
    });

    it("waits for the composition to end before sending", async () => {
      let composing = true;
      const { autosave, saves } = setup({ composing: () => composing });
      autosave.change({ title: "変換中" });
      let state: SaveState | null = null;
      void autosave.settle().then((value) => (state = value));
      await vi.advanceTimersByTimeAsync(3000);
      expect(saves).toEqual([]);
      expect(state).toBeNull();
      composing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(saves).toEqual([{ title: "変換中" }]);
      expect(state).toBe("saved");
    });

    it("resolves with the failure when its own attempt fails, keeping the change pending", async () => {
      const { autosave, setFail } = setup();
      setFail(new Offline("Failed to fetch"));
      autosave.change({ title: "a" });
      await expect(autosave.settle()).resolves.toBe("offline");
      expect(autosave.hasPending()).toBe(true);
      setFail(new SignedOut("401"));
      await expect(autosave.settle()).resolves.toBe("signedOut");
      // 戻れば保存して saved
      setFail(false);
      await expect(autosave.settle()).resolves.toBe("saved");
    });

    it("resolves stopped at once when autosave is stopped (conflict), sending nothing", async () => {
      const { autosave, saves, setFail } = setup();
      setFail(new Conflict("409"));
      autosave.change({ title: "a" });
      await expect(autosave.settle()).resolves.toBe("stopped");
      autosave.change({ title: "ab" });
      await expect(autosave.settle()).resolves.toBe("stopped");
      expect(saves).toHaveLength(1);
    });

    it("lets a waiting settle go when the editor is closed", async () => {
      const autosave = createAutosave<Patch>({ save: () => new Promise<void>(() => undefined), isComposing: () => false, onState: () => undefined });
      autosave.change({ title: "a" });
      let done = false;
      void autosave.settle().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      autosave.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    });
  });

  it("stops after dispose", async () => {
    const { autosave, saves, onlineListeners } = setup();
    autosave.change({ title: "a" });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
    expect(onlineListeners()).toBe(0);
  });
});
