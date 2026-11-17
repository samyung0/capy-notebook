/** How `held` entries (a table's rows or columns, a chart's series or labels)
 * line up with `count` wanted ones as one editor action leaves them: entries
 * alike at the head and tail (`same(heldIndex, wantedIndex)`) keep their
 * place, a changed middle keeps as many as it can by position, and the rest
 * go or come. With the count unchanged every entry keeps its place. For each
 * wanted index, the held index it keeps, or -1 for a new entry. Pure, so the
 * room writer (`alignAxis`) and a plain block's binding share it. */
export function alignPlaces(
  held: number,
  count: number,
  same: (held: number, wanted: number) => boolean
): number[] {
  let head = 0;
  while (head < held && head < count && same(head, head)) head++;
  let tail = 0;
  while (
    tail < held - head &&
    tail < count - head &&
    same(held - 1 - tail, count - 1 - tail)
  )
    tail++;
  const keep = Math.min(held - head - tail, count - head - tail);
  return Array.from({ length: count }, (_, w) =>
    w < head + keep ? w : w >= count - tail ? held - (count - w) : -1
  );
}
