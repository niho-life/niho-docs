import { describe, expect, it, vi } from "vitest";
import { StepsRequestError, cancelStepRun, getStepRun, isStepRunDone, startStepRun, type StepRun } from "./steps-client";

const PARENT = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

const RUN = {
  id: "run-1",
  recipe: "tpl-1",
  state: "queued",
  fromStep: 0,
  steps: [{ index: 0, id: "k7m2q9xa", name: "文字起こし修正", state: "queued", pageId: "page-0", stepStatus: "wait", tries: 0, errorCode: null }],
} satisfies StepRun;

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchOnce = (status: number, body: unknown) => vi.fn<typeof fetch>(async () => respond(status, body));

describe("steps-client", () => {
  it("読み出しは同じ origin の GET で、cookie を送り、応答を蓄えない", async () => {
    const fetchImpl = fetchOnce(200, { run: RUN });
    expect(await getStepRun(PARENT, fetchImpl)).toEqual(RUN);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/pages/${PARENT}/steps`);
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("手順が無ければ null", async () => {
    expect(await getStepRun(PARENT, fetchOnce(200, { run: null }))).toBeNull();
  });

  it("始めるときは recipe（と fromStep）だけを送る。Idempotency-Key は渡されたときだけ", async () => {
    const fetchImpl = fetchOnce(202, { run: RUN });
    await startStepRun(PARENT, { recipe: "tpl-1" }, fetchImpl);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe(`/api/pages/${PARENT}/steps/runs`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ recipe: "tpl-1" });
    expect(new Headers(init!.headers).has("idempotency-key")).toBe(false);

    const again = fetchOnce(200, { run: RUN });
    await startStepRun(PARENT, { recipe: "tpl-1", fromStep: 2, idempotencyKey: "abc-1" }, again);
    const next = again.mock.calls[0]![1]!;
    expect(JSON.parse(next.body as string)).toEqual({ recipe: "tpl-1", fromStep: 2 });
    expect(new Headers(next.headers).get("idempotency-key")).toBe("abc-1");
  });

  it("取消は run の id を path に入れる", async () => {
    const fetchImpl = fetchOnce(200, { run: { ...RUN, state: "canceled" } });
    expect((await cancelStepRun(PARENT, "run 1", fetchImpl)).state).toBe("canceled");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/pages/${PARENT}/steps/runs/run%201/cancel`);
  });

  it("失敗は status と短い code だけを持つ（本文は持たない）", async () => {
    await expect(startStepRun(PARENT, { recipe: "tpl-1" }, fetchOnce(409, { error: "run_in_progress" }))).rejects.toMatchObject({
      name: "StepsRequestError",
      status: 409,
      error: "run_in_progress",
    });
    await expect(getStepRun(PARENT, fetchOnce(401, { error: "unauthorized" }))).rejects.toMatchObject({ status: 401, error: "unauthorized" });
    // JSON でない応答でも、形の分からない失敗として扱う
    const broken = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 503 }));
    await expect(getStepRun(PARENT, broken)).rejects.toBeInstanceOf(StepsRequestError);
  });

  it("形の違う応答は受けない（知らない状態・段階の無い run・足りない欄）", async () => {
    const bad: unknown[] = [
      { run: { ...RUN, state: "unknown" } },
      { run: { ...RUN, steps: [] } },
      { run: { ...RUN, fromStep: -1 } },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], stepStatus: "weird" }] } },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], state: "nope" }] } },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], tries: 1.5 }] } },
      { run: {} },
      {},
    ];
    for (const body of bad) {
      await expect(getStepRun(PARENT, fetchOnce(200, body))).rejects.toBeInstanceOf(StepsRequestError);
    }
  });

  it("終わった run は読み直さなくてよい", () => {
    expect(isStepRunDone(null)).toBe(false);
    expect(isStepRunDone({ ...RUN, state: "queued" })).toBe(false);
    expect(isStepRunDone({ ...RUN, state: "running" })).toBe(false);
    for (const state of ["succeeded", "failed", "canceled"] as const) expect(isStepRunDone({ ...RUN, state })).toBe(true);
  });
});
