import { expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';

it('round-trips an answer too large to spread into one call', () => {
  const bytes = new Uint8Array(1_000_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const back = fromBase64(toBase64(bytes));
  // Compared as buffers: a deep equal over a million elements took most of the time limit.
  expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
});
