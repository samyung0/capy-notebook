import { expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

it('reads and writes the standard base64 of a few bytes', () => {
  // A presence position's size: every byte value, and each padding length.
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const length of [0, 1, 2, 3, 256]) {
    const part = bytes.subarray(0, length);
    const text = Buffer.from(part).toString('base64');
    expect(bytesToBase64(part)).toBe(text);
    expect(base64ToBytes(text)).toEqual(part);
  }
});

it('round-trips a board near its cap', () => {
  const bytes = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  const text = bytesToBase64(bytes);
  expect(text).toBe(Buffer.from(bytes).toString('base64'));
  // Compared as buffers: a deep equal over millions of elements is slow.
  expect(Buffer.from(base64ToBytes(text)).equals(Buffer.from(bytes))).toBe(
    true
  );
});
