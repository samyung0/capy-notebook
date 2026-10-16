import { expect, it } from 'vitest';
import { waitsForConnection } from './online';

it.each([
  ['paused', undefined, true],
  // Data held, even an empty list, stays on screen while the refetch waits.
  ['paused', [{ id: 'ws_1' }], false],
  ['paused', [], false],
  ['fetching', undefined, false],
  ['idle', undefined, false],
] as const)(
  'a %s query holding %j waits for the connection: %s',
  (fetchStatus, data, waits) => {
    expect(waitsForConnection(fetchStatus, data)).toBe(waits);
  }
);
