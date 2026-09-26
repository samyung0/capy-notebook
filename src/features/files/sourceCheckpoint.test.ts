import { expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { OFFICE_EDITING_PAUSED_REASON } from './sourceProvider';
import {
  acknowledgeSourceCheckpoint,
  maintenancePaused,
  sourceChangesCovered,
} from './useSourceSession';

it('keeps later authored changes dirty when an earlier or unrelated checkpoint is acknowledged', () => {
  const state = {
    acknowledged: -1,
    pending: new Map([
      ['first', 1],
      ['second', 2],
    ]),
    sequence: 2,
  };
  expect(acknowledgeSourceCheckpoint(state, ['unrelated'])).toBe(false);
  expect(acknowledgeSourceCheckpoint(state, ['first'])).toBe(false);
  expect(state.acknowledged).toBe(1);
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(true);
  expect(acknowledgeSourceCheckpoint(state, ['unrelated'])).toBe(false);
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(false);
  state.sequence++;
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(false);
});

it('keeps a replaced view under the banner only when the server holds its changes, and skips drafts only for receipts', () => {
  const state = { acknowledged: 2, sequence: 3 };
  // A silent editor never answered ready: its unsaved change goes to recovery.
  expect(sourceChangesCovered(state)).toBe(false);
  // Ready at sequence 3: the publication holds the change, so the banner
  // shows, but the draft is still written until a receipt covers it.
  expect(sourceChangesCovered(state, 3)).toBe(true);
  state.acknowledged = 3;
  expect(sourceChangesCovered(state)).toBe(true);
  // An edit after ready (or after the receipt) is unsaved again.
  state.sequence++;
  expect(sourceChangesCovered(state, 3)).toBe(false);
});

it('takes the maintenance pause from either refusal to the paused view', () => {
  // The collaboration service's authentication reason, and the gateway's 423
  // on a reconnect's token or an Edit open.
  expect(maintenancePaused(OFFICE_EDITING_PAUSED_REASON)).toBe(true);
  expect(
    maintenancePaused(
      new ApiError(423, 'Locked', 'office editing is paused for maintenance', {
        code: 'office_editing_paused',
      })
    )
  ).toBe(true);
  expect(maintenancePaused('permission-denied')).toBe(false);
  expect(
    maintenancePaused(new ApiError(403, 'Forbidden', '', { code: 'x' }))
  ).toBe(false);
});
