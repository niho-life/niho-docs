import { describe, expect, it, vi } from "vitest";
import { createInlineDispatcher, resolveDispatcherKind } from "./dispatch";

describe("transcription dispatcher", () => {
  it("is inline outside production and absent in production", () => {
    expect(resolveDispatcherKind({})).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "development" })).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "test" })).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "production" })).toBeNull();
  });

  it("runs the execution after returning, without waiting for it", async () => {
    const tasks: Array<() => void> = [];
    const execute = vi.fn(async () => undefined);
    const dispatcher = createInlineDispatcher({ execute, failQueued: vi.fn(), schedule: (task) => tasks.push(task) });
    expect(dispatcher.kind).toBe("inline");
    await dispatcher.dispatch("run-1");
    expect(execute).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    tasks[0]!();
    expect(execute).toHaveBeenCalledWith("run-1");
  });

  it("does not swallow an unexpected failure: reports it and fails the run that was never claimed", async () => {
    const failQueued = vi.fn(async () => true);
    const onError = vi.fn();
    const dispatcher = createInlineDispatcher({
      execute: async () => {
        throw new TypeError("synthetic failure");
      },
      failQueued,
      onError,
    });
    await dispatcher.dispatch("run-2");
    await vi.waitFor(() => expect(failQueued).toHaveBeenCalledWith("run-2"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toBeInstanceOf(TypeError);
  });

  it("logs only the error name by default", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dispatcher = createInlineDispatcher({
      execute: async () => {
        throw new Error("secret-looking detail test-key-not-secret");
      },
      failQueued: async () => {
        throw new Error("failing too");
      },
    });
    await dispatcher.dispatch("run-3");
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("test-key-not-secret");
    expect(errors.mock.calls[0]).toEqual(["editor-web: inline transcription failed", { name: "Error" }]);
    errors.mockRestore();
  });
});
