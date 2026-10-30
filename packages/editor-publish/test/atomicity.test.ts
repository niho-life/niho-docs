/**
 * Atomicity: for every operation, make the k-th store call throw for every k from the first call to the
 * commit, and check each time that the store holds exactly what it held before and the result is
 * `failed` (retryable). Then retry without the fault and check it succeeds.
 */

import { describe, expect, it } from "vitest";
import { SCENARIOS, type Scenario } from "./support/scenarios.js";
import { PAGE_ID, createWorld, type World } from "./support/world.js";

async function prepared(scenario: Scenario): Promise<World> {
  const world = createWorld();
  await scenario.setup(world);
  return world;
}

describe("atomicity: a store failure at any call leaves everything as it was", () => {
  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))("%s", async (_name, scenario) => {
    const probe = await prepared(scenario);
    probe.store.resetCallCount();
    const success = await scenario.run(probe);
    expect(success.ok).toBe(true);
    const calls = probe.store.callCount;
    expect(calls).toBeGreaterThanOrEqual(3);

    for (let k = 1; k <= calls; k += 1) {
      const world = await prepared(scenario);
      const before = world.store.dump();
      world.store.failOnCall(k);
      const result = await scenario.run(world);
      expect(result, `call ${k} of ${calls}`).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(world.store.dump(), `call ${k} of ${calls}`).toBe(before);
      world.store.failOnCall(null);
      expect((await scenario.run(world)).ok, `retry after call ${k}`).toBe(true);
    }
  });

  it("injects at the commit too (the last counted call)", async () => {
    const scenario = SCENARIOS[0] as Scenario;
    const probe = await prepared(scenario);
    probe.store.resetCallCount();
    await scenario.run(probe);
    const world = await prepared(scenario);
    const before = world.store.dump();
    world.store.failOnCall(probe.store.callCount);
    expect(await scenario.run(world)).toEqual({ ok: false, reason: "failed", retryable: true });
    expect(world.store.dump()).toBe(before);
    expect(world.store.publication(PAGE_ID)).toBeNull();
  });
});
