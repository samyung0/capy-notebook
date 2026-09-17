/** Flatten RHF/zod errors for a tag array: item `.value` issues plus array-level max. */
export function flattenTagErrors(error: unknown): Array<{ message?: string }> {
  if (!error || typeof error !== 'object') return [];
  const seen = new Set<string>();
  const out: Array<{ message?: string }> = [];
  const add = (message?: string) => {
    if (!message || seen.has(message)) return;
    seen.add(message);
    out.push({ message });
  };

  const rec = error as {
    message?: string;
    root?: { message?: string };
    value?: { message?: string };
  };
  add(rec.message);
  add(rec.root?.message);
  add(rec.value?.message);

  for (const item of Object.values(error)) {
    if (!item || typeof item !== 'object') continue;
    const nested = item as { message?: string; value?: { message?: string } };
    add(nested.message);
    add(nested.value?.message);
  }
  return out;
}
