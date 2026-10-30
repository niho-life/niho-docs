import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryTaskQueue, taskName } from "./queue";

describe("MemoryTaskQueue", () => {
  it("drops a task whose name was already queued, and drains in order", async () => {
    const queue = new MemoryTaskQueue();
    const runId = randomUUID();
    expect(await queue.enqueue({ name: taskName(runId, 0, 0), runId, stepIndex: 0 })).toEqual({ deduplicated: false });
    expect(await queue.enqueue({ name: taskName(runId, 0, 0), runId, stepIndex: 0 })).toEqual({ deduplicated: true });
    // 世代が進めば同じ段階を積み直せる
    expect(await queue.enqueue({ name: taskName(runId, 0, 1), runId, stepIndex: 0, delaySeconds: 10 })).toEqual({ deduplicated: false });
    expect(queue.size).toBe(2);
    expect(queue.drain().map((task) => [task.name, task.delaySeconds])).toEqual([
      [taskName(runId, 0, 0), undefined],
      [taskName(runId, 0, 1), 10],
    ]);
    expect(queue.drain()).toEqual([]);
    // 取り出した後も同じ名前は積まない（Cloud Tasks と同じく名前は使い切り）
    expect(await queue.enqueue({ name: taskName(runId, 0, 0), runId, stepIndex: 0 })).toEqual({ deduplicated: true });
  });

  it("names tasks with the run, the step and the generation in characters Cloud Tasks accepts", () => {
    const runId = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    expect(taskName(runId, 2, 3)).toBe("6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11-2-3");
    expect(taskName(runId, 1, 23)).not.toBe(taskName(runId, 12, 3));
    expect(taskName(runId, 12, 3)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });
});
