/* Order keys for live item lists (live-items DESIGN.md 1.1): the base-62
 * strings of fractional-indexing 3.2.0's generateKeyBetween (CC0), ported so
 * the browser and the collaboration server (collaboration-rs/crates/notes/
 * src/order.rs, which checks every key a writer sends) agree. A move sets a
 * new key between the neighbours instead of deleting and inserting, so an
 * edit inside the moved entry survives. */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b === null ? DIGITS.length : DIGITS.indexOf(b[0]);
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function incrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digits.push(ZERO);
  else digits.pop();
  return h + digits.join('');
}

function decrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) digits[i] = DIGITS.at(-1) as string;
    else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return `Z${DIGITS.at(-1)}`;
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digits.push(DIGITS.at(-1) as string);
  else digits.pop();
  return h + digits.join('');
}

/** A key strictly between `a` and `b` (`null` is the start or the end). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('cannot decrement any more');
    return res;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) {
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error('cannot increment any more');
  return i < b ? i : ia + midpoint(fa, null);
}

/** Order keys for `count` new entries between two existing ones. */
export function keysBetween(
  after: string | null,
  before: string | null,
  count: number
) {
  const out: string[] = [];
  let last = after;
  for (let i = 0; i < count; i++) {
    last = keyBetween(last, before);
    out.push(last);
  }
  return out;
}

type Held = { id: string; order: string };

/** Order keys for entries wanted in the given order, from each entry's id and
 * the key it holds ('' for one with none yet). Held keys are compared with
 * ties broken by id, as readers sort, and the most that already rise in that
 * order stay (the longest rising run): an untouched entry keeps its key, a tie
 * two editors' adds left that reads in the wanted order stays, and entries
 * appended after held ones re-key nothing. Every other entry (a moved or a new
 * one) takes a key between its neighbours; one placed between tied
 * neighbours, where no key fits, re-keys the later tied neighbours with it. */
export function risingOrders(held: readonly Held[]): string[] {
  return placed(held, null, null);
}

/** Whether `order` is a key strictly between `lower` and `upper` (null: the
 * start or the end). */
const within = (order: string, lower: string | null, upper: string | null) =>
  order !== '' &&
  (lower === null || order > lower) &&
  (upper === null || order < upper);

/** `risingOrders` for entries placed between `lower` and `upper`: only a held
 * key inside them can stay, and each gap between kept entries is placed the
 * same way between its neighbours, so a held key inside a gap stays too. */
function placed(
  held: readonly Held[],
  lower: string | null,
  upper: string | null
): string[] {
  const below = (a: number, b: number) =>
    held[a].order < held[b].order ||
    (held[a].order === held[b].order && held[a].id < held[b].id);
  // Longest strictly rising subsequence (patience sorting): `tails[n]` is the
  // entry ending the best run of length n + 1 so far, `previous` links runs.
  const tails: number[] = [];
  const previous = held.map(() => -1);
  held.forEach(({ order }, i) => {
    if (!within(order, lower, upper)) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (below(tails[mid], i)) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  });
  // Nothing to keep: every entry takes a new key (this ends the recursion,
  // since a gap is smaller than the list that kept an entry).
  if (tails.length === 0) return keysBetween(lower, upper, held.length);
  const kept = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) kept.add(i);
  const orders = held.map(({ order }) => order);
  for (let i = 0; i < orders.length; i++) {
    if (kept.has(i)) continue;
    // The entry before a gap is a kept one holding its own key; kept entries
    // tied with it join the gap, so the gap ends at a greater key.
    const after = i > 0 ? orders[i - 1] : lower;
    let end = i;
    while (end < orders.length && (!kept.has(end) || orders[end] === after))
      end++;
    const before = end < orders.length ? orders[end] : upper;
    placed(held.slice(i, end), after, before).forEach((key, k) => {
      orders[i + k] = key;
    });
    i = end;
  }
  return orders;
}
