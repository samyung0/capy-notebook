import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { qk } from './client';
import { applyNotificationEvent } from './hooks';

describe('billing stream event', () => {
  it('refetches billing, leaving a pending billing save to its own refetch', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyNotificationEvent(qc, { type: 'billing' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.billing });

    invalidate.mockClear();
    vi.spyOn(qc, 'isMutating').mockReturnValue(1);
    applyNotificationEvent(qc, { type: 'billing' });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
