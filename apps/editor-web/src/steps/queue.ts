/** 段階を 1 つ実行する task（後段で Cloud Tasks に積む。本文・秘密は入れない）。 */
export type StepTask = { name: string; runId: string; stepIndex: number; delaySeconds?: number };

export type TaskQueue = {
  /** 同じ名前の task は 1 度だけ積む（2 度目からは `deduplicated: true`）。 */
  enqueue(task: StepTask): Promise<{ deduplicated: boolean }>;
};

/**
 * task の名前（決め方はここだけ）。run・段階・世代を入れ、同じ段階でも世代が進めば積み直せる（再試行・掃除の後）。
 * Cloud Tasks の task 名に使える文字（英数字・`-`・`_`）だけにする。run の id は UUID（長さが決まっている）なので区切りは曖昧にならない。
 */
export function taskName(runId: string, stepIndex: number, generation: number): string {
  return `${runId}-${stepIndex}-${generation}`;
}

/** メモリの中のキュー（テストと inline 用）。名前で重複を除き、取り出しは `drain()`。 */
export class MemoryTaskQueue implements TaskQueue {
  readonly #names = new Set<string>();
  #pending: StepTask[] = [];

  async enqueue(task: StepTask): Promise<{ deduplicated: boolean }> {
    if (this.#names.has(task.name)) return { deduplicated: true };
    this.#names.add(task.name);
    this.#pending.push({ ...task });
    return { deduplicated: false };
  }

  /** 積まれている task を全て取り出す（積んだ順）。 */
  drain(): StepTask[] {
    const tasks = this.#pending;
    this.#pending = [];
    return tasks;
  }

  get size(): number {
    return this.#pending.length;
  }
}
