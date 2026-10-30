/**
 * Redirects of old URLs on NIHO-operated faces (#39). Faces redirect a stopped page's URL to their
 * list, and an old URL to the new one after a face-to-face move. Owners' sites get no redirects.
 * Chains are kept one step long: adding `A → B` re-points every `X → A` to `X → B`.
 */

/** A URL on a destination: the readable handle (`exp` / `niho` for faces) and the slug. */
export interface Place {
  readonly handle: string;
  readonly slug: string;
}

export type RedirectTarget = Place | "list";

export interface Redirect {
  readonly from: Place;
  readonly to: RedirectTarget;
}

export const MAX_REDIRECT_HOPS = 8;

export function placeKey(place: Place): string {
  return `${place.handle}/${place.slug}`;
}

export function samePlace(a: RedirectTarget, b: RedirectTarget): boolean {
  if (a === "list" || b === "list") return a === b;
  return a.handle === b.handle && a.slug === b.slug;
}

/**
 * Where `from` finally leads: a place, `"list"`, or null when `from` has no redirect.
 * Follows at most 8 hops; a loop or a longer chain resolves to the list.
 */
export function resolveRedirect(redirects: readonly Redirect[], from: Place): RedirectTarget | null {
  const index = new Map(redirects.map((redirect) => [placeKey(redirect.from), redirect] as const));
  let current = from;
  const seen = new Set([placeKey(from)]);
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const redirect = index.get(placeKey(current));
    if (!redirect) return hop === 0 ? null : current;
    if (redirect.to === "list") return "list";
    const key = placeKey(redirect.to);
    if (seen.has(key)) return "list";
    seen.add(key);
    current = redirect.to;
  }
  return index.has(placeKey(current)) ? "list" : current;
}

export interface RedirectPlan<R extends Redirect> {
  /** Redirects to write (keyed by `from`; replaces an existing one). */
  readonly put: readonly R[];
  /** Places whose redirect must be deleted. */
  readonly remove: readonly Place[];
}

/**
 * What to change when adding `next`, given the redirects that currently point at `next.from`.
 * They are re-pointed to `next.to` (one step); one that would point at itself is removed.
 */
export function planRedirect<R extends Redirect>(pointingAtFrom: readonly R[], next: R): RedirectPlan<R> {
  const put: R[] = [];
  const remove: Place[] = [];
  for (const redirect of pointingAtFrom) {
    if (!samePlace(redirect.to, next.from)) continue;
    if (samePlace(redirect.from, next.to)) remove.push(redirect.from);
    else put.push({ ...redirect, to: next.to });
  }
  if (!samePlace(next.from, next.to)) put.push(next);
  return { put, remove };
}

/**
 * Pure form over a whole list: adds `next`, keeps chains one step long, and drops the redirect from
 * `next.to` (that place is live now).
 */
export function linkRedirect<R extends Redirect>(redirects: readonly R[], next: R): R[] {
  const plan = planRedirect(redirects.filter((redirect) => samePlace(redirect.to, next.from)), next);
  const dropped = new Set([...plan.remove, ...plan.put.map((redirect) => redirect.from)].map(placeKey));
  if (next.to !== "list") dropped.add(placeKey(next.to));
  return [...redirects.filter((redirect) => !dropped.has(placeKey(redirect.from))), ...plan.put];
}
