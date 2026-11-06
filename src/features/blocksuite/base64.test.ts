import { expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';

it('round-trips an answer too large to spread into one call', () => {
  const bytes = Uint8Array.from({ length: 1_000_000 }, (_, i) => i % 256);
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
});
