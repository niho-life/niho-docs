import { describe, expect, it } from "vitest";
import { MAX_REDIRECT_HOPS, linkRedirect, planRedirect, resolveRedirect, type Place, type Redirect } from "../src/index.js";

const at = (handle: string, slug: string): Place => ({ handle, slug });
const A = at("niho", "a");
const B = at("exp", "b");
const C = at("niho", "c");
const D = at("exp", "d");

function chain(length: number): Redirect[] {
  return Array.from({ length }, (_, index) => ({ from: at("niho", `p${index}`), to: at("niho", `p${index + 1}`) }));
}

describe("resolveRedirect", () => {
  it("returns null when there is no redirect", () => {
    expect(resolveRedirect([{ from: A, to: B }], C)).toBeNull();
  });

  it("follows one step to a place or the list", () => {
    expect(resolveRedirect([{ from: A, to: B }], A)).toEqual(B);
    expect(resolveRedirect([{ from: A, to: "list" }], A)).toBe("list");
  });

  it("follows a chain to its end", () => {
    expect(resolveRedirect([{ from: A, to: B }, { from: B, to: C }, { from: C, to: "list" }], A)).toBe("list");
    expect(resolveRedirect(chain(3), at("niho", "p0"))).toEqual(at("niho", "p3"));
  });

  it(`follows at most ${MAX_REDIRECT_HOPS} steps; a longer chain goes to the list`, () => {
    expect(resolveRedirect(chain(MAX_REDIRECT_HOPS), at("niho", "p0"))).toEqual(at("niho", `p${MAX_REDIRECT_HOPS}`));
    expect(resolveRedirect(chain(MAX_REDIRECT_HOPS + 1), at("niho", "p0"))).toBe("list");
  });

  it("treats a loop as the list", () => {
    expect(resolveRedirect([{ from: A, to: B }, { from: B, to: A }], A)).toBe("list");
    expect(resolveRedirect([{ from: A, to: A }], A)).toBe("list");
  });

  it("distinguishes handles", () => {
    expect(resolveRedirect([{ from: at("exp", "a"), to: B }], at("niho", "a"))).toBeNull();
  });
});

describe("linkRedirect / planRedirect: chains stay one step long", () => {
  it("re-points X → old to X → new when adding old → new", () => {
    const after = linkRedirect([{ from: A, to: B }], { from: B, to: C });
    expect(after).toEqual([{ from: A, to: C }, { from: B, to: C }]);
  });

  it("re-points to the list when the page stops", () => {
    const after = linkRedirect<Redirect>(linkRedirect<Redirect>([{ from: A, to: B }], { from: B, to: C }), { from: C, to: "list" });
    expect(after).toEqual([{ from: A, to: "list" }, { from: B, to: "list" }, { from: C, to: "list" }]);
  });

  it("drops a redirect that would point at itself and the one from the new live place (moving back)", () => {
    const after = linkRedirect([{ from: A, to: B }], { from: B, to: A });
    expect(after).toEqual([{ from: B, to: A }]);
  });

  it("replaces an existing redirect from the same place", () => {
    expect(linkRedirect([{ from: A, to: "list" }], { from: A, to: D })).toEqual([{ from: A, to: D }]);
  });

  it("keeps the extra fields of re-pointed records", () => {
    const plan = planRedirect([{ from: A, to: B, pageId: "p1" }], { from: B, to: C, pageId: "p1" });
    expect(plan).toEqual({ put: [{ from: A, to: C, pageId: "p1" }, { from: B, to: C, pageId: "p1" }], remove: [] });
  });

  it("never builds a chain longer than one step (random moves and stops)", () => {
    let seed = 7;
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const places = [A, B, C, D, at("niho", "e"), at("exp", "f")];
    for (let run = 0; run < 50; run += 1) {
      let redirects: Redirect[] = [];
      let current = places[random(places.length)] as Place;
      for (let step = 0; step < 12; step += 1) {
        const next = places[random(places.length)] as Place;
        if (random(4) === 0) {
          redirects = linkRedirect(redirects, { from: current, to: "list" });
        } else if (next.handle !== current.handle || next.slug !== current.slug) {
          redirects = linkRedirect(redirects, { from: current, to: next });
          current = next;
        }
        const froms = new Set(redirects.map((redirect) => `${redirect.from.handle}/${redirect.from.slug}`));
        for (const redirect of redirects) {
          if (redirect.to !== "list") expect(froms.has(`${redirect.to.handle}/${redirect.to.slug}`)).toBe(false);
        }
        expect(froms.size).toBe(redirects.length);
      }
    }
  });
});
