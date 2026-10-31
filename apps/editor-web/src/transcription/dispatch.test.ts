import { describe, expect, it, vi } from "vitest";
import type { TranscriptionQueue } from "./cloud-tasks";
import { createCloudTasksDispatcher, createInlineDispatcher, resolveDispatcherKind } from "./dispatch";

// 合成の値だけ（本物のプロジェクト・URL・メールを入れない）
const TASKS_ENV = {
  EDITOR_TRANSCRIBE_MODE: "cloud-tasks",
  EDITOR_TRANSCRIBE_QUEUE: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-transcribe",
  EDITOR_TRANSCRIBE_WORKER_URL: "https://worker.example.test",
  EDITOR_TRANSCRIBE_INVOKER_SA: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const RUN_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

describe("transcription dispatcher", () => {
  it("is inline outside production and absent in production while the mode is unset", () => {
    expect(resolveDispatcherKind({})).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "development" })).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "test" })).toBe("inline");
    expect(resolveDispatcherKind({ NODE_ENV: "production" })).toBeNull();
    expect(resolveDispatcherKind({ NODE_ENV: "production", EDITOR_TRANSCRIBE_MODE: "" })).toBeNull();
    // inline は本番では受け付けない（同じプロセスで長い文字起こしを続けられる保証が無い）
    expect(resolveDispatcherKind({ NODE_ENV: "production", EDITOR_TRANSCRIBE_MODE: "inline" })).toBeNull();
    expect(resolveDispatcherKind({ NODE_ENV: "development", EDITOR_TRANSCRIBE_MODE: "inline" })).toBe("inline");
  });

  it("is cloud-tasks in production when the queue, the worker URL and the invoker service account are all set", () => {
    expect(resolveDispatcherKind({ NODE_ENV: "production", ...TASKS_ENV })).toBe("cloud-tasks");
    // 本番でなくても、方式を選べば Cloud Tasks（配備の前に設定を確かめられる）
    expect(resolveDispatcherKind({ NODE_ENV: "development", ...TASKS_ENV })).toBe("cloud-tasks");
    // 1 つでも欠ければ閉じたまま（本番で inline に落ちることはない）
    for (const name of ["EDITOR_TRANSCRIBE_QUEUE", "EDITOR_TRANSCRIBE_WORKER_URL", "EDITOR_TRANSCRIBE_INVOKER_SA"] as const) {
      expect(resolveDispatcherKind({ NODE_ENV: "production", ...TASKS_ENV, [name]: undefined }), name).toBeNull();
    }
    // 知らない値・off は閉じたまま（開発でも inline に落ちない）
    expect(resolveDispatcherKind({ NODE_ENV: "development", EDITOR_TRANSCRIBE_MODE: "off" })).toBeNull();
    expect(resolveDispatcherKind({ NODE_ENV: "development", EDITOR_TRANSCRIBE_MODE: "cloud-run" })).toBeNull();
  });

  it("enqueues the queued run (generation 0) and counts an already queued task as done", async () => {
    const enqueue = vi.fn(async () => ({ deduplicated: false }));
    const queue: TranscriptionQueue = { enqueue };
    const dispatcher = createCloudTasksDispatcher({ queue });
    expect(dispatcher.kind).toBe("cloud-tasks");
    await dispatcher.dispatch(RUN_ID);
    expect(enqueue).toHaveBeenCalledWith({ name: `${RUN_ID}-0`, runId: RUN_ID });

    enqueue.mockResolvedValueOnce({ deduplicated: true });
    await expect(dispatcher.dispatch(RUN_ID)).resolves.toBeUndefined();
  });

  it("rejects when the task cannot be enqueued, so the start fails the run instead of leaving it queued", async () => {
    const dispatcher = createCloudTasksDispatcher({
      queue: {
        enqueue: async () => {
          throw new Error("synthetic failure");
        },
      },
    });
    await expect(dispatcher.dispatch(RUN_ID)).rejects.toThrow("synthetic failure");
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
