/* Order keys for live item lists (live-items DESIGN.md 1.1): the base-62
 * strings of fractional-indexing 3.2.0's generateKeyBetween (CC0), ported so
 * the browser and the collaboration server (collaboration-rs/crates/items/
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
