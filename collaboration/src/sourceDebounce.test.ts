import { expect, test, vi } from 'vitest';
import {
  debounceSourceStores,
  persistsNow,
  storeDebounced,
} from './sourceDebounce.js';

test('source rooms store on their own debounce; material rooms and immediate stores keep theirs', () => {
  const debounce = vi.fn();
  const isDebounced = vi.fn((id: string) => id.endsWith(':epoch:2'));
  const host = { debouncer: { debounce, isDebounced } };
  debounceSourceStores(host as never, 5000, 30_000);
  const run = () => undefined;
  host.debouncer.debounce(
    'onStoreDocument-source:f_1:epoch:2',
    run,
    2000,
    10_000
  );
  host.debouncer.debounce('onStoreDocument-source:f_1:epoch:2', run, 0, 10_000);
  host.debouncer.debounce(
    'onStoreDocument-material:m_1:schema:1',
    run,
    2000,
    10_000
  );
  expect(debounce.mock.calls.map((call) => call.slice(2))).toEqual([
    [5000, 30_000],
    [0, 10_000],
    [2000, 10_000],
  ]);
  expect(storeDebounced(host as never, 'source:f_1:epoch:2')).toBe(true);
  expect(isDebounced).toHaveBeenCalledWith(
    'onStoreDocument-source:f_1:epoch:2'
  );
});

test('an explicit save persists now; an idle request waits only for a pending debounced store', () => {
  let pending = true;
  const host = { debouncer: { isDebounced: () => pending } };
  expect(persistsNow(host as never, 'source:f_1:epoch:1', true)).toBe(true);
  expect(persistsNow(host as never, 'source:f_1:epoch:1', false)).toBe(false);
  pending = false;
  expect(persistsNow(host as never, 'source:f_1:epoch:1', false)).toBe(true);
});
