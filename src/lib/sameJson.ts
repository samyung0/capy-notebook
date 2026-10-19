const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether two JSON values are equal: object keys in any order, a key holding
 * `undefined` counted as absent (as JSON drops it). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  if (!(isRecord(a) && isRecord(b))) return false;
  const keys = (value: Record<string, unknown>) =>
    Object.keys(value).filter((key) => value[key] !== undefined);
  const left = keys(a);
  return (
    left.length === keys(b).length &&
    left.every((key) => sameJson(a[key], b[key]))
  );
}
