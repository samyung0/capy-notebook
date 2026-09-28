/**
 * Runs an access check for a key (a connection) at most once per interval.
 * A check that throws is not remembered, so the next call checks again.
 */
export function accessRecheck(intervalMs: number, now = Date.now) {
  const checked = new WeakMap<object, number>();
  return async (key: object, check: () => Promise<unknown>) => {
    const at = checked.get(key);
    if (at !== undefined && now() - at < intervalMs) return;
    await check();
    checked.set(key, now());
  };
}
