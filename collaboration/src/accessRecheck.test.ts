import { expect, test, vi } from 'vitest';
import { accessRecheck } from './accessRecheck.js';

test('a connection is revalidated at most once per interval, and a refusal is not remembered', async () => {
  let now = 0;
  const recheck = accessRecheck(5000, () => now);
  const connection = {};
  const check = vi.fn(async () => undefined);
  await recheck(connection, check);
  now = 4999;
  await recheck(connection, check);
  expect(check).toHaveBeenCalledTimes(1);
  await recheck({}, check);
  expect(check).toHaveBeenCalledTimes(2);
  now = 5000;
  const refused = vi.fn(async () => {
    throw new Error('revoked');
  });
  await expect(recheck(connection, refused)).rejects.toThrow('revoked');
  now = 5001;
  await expect(recheck(connection, refused)).rejects.toThrow('revoked');
  expect(refused).toHaveBeenCalledTimes(2);
});
