import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { applyNotificationEvent } from './hooks';

it('refetches the To do lists once for a burst of todo events', () => {
  vi.useFakeTimers();
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  for (let i = 0; i < 5; i++) applyNotificationEvent(qc, { type: 'todo' });
  vi.advanceTimersByTime(1000);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todo'] });
  vi.useRealTimers();
});
