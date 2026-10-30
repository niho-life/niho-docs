/** Recursively freezes plain objects and arrays. Returns the same value. */
export function deepFreeze<T>(value: T): T {
  freeze(value, new WeakSet());
  return value;
}

function freeze(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key], seen);
  Object.freeze(value);
}
