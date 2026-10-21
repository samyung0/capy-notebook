import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { onSyncedCustomization } from '@/theme/customizationEvents';
import { applyNotificationEvent } from './hooks';

describe('customization stream event', () => {
  it('refetches /api/me and hands the synced look to the app', async () => {
    const customization = {
      pageFrame: { pattern: 'arc' },
      style: 'notion',
      theme: 'mocha',
    };
    const qc = new QueryClient();
    const fetchMe = vi
      .spyOn(qc, 'fetchQuery')
      .mockResolvedValue({ customization } as never);
    const adopted = vi.fn();
    const stop = onSyncedCustomization(adopted);
    applyNotificationEvent(qc, { type: 'customization' });
    await vi.waitFor(() => expect(adopted).toHaveBeenCalledWith(customization));
    expect(fetchMe).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['me'], staleTime: 0 })
    );
    stop();
  });
});
