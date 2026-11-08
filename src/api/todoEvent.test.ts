import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { applyNotificationEvent } from './hooks';

it('refetches To do and the Dashboards once for a burst of todo events', () => {
  vi.useFakeTimers();
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  for (let i = 0; i < 5; i++) applyNotificationEvent(qc, { type: 'todo' });
  vi.advanceTimersByTime(1000);
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['todo'] });
  const [filters] = invalidate.mock.calls[1] ?? [];
  const { predicate } = filters as {
    predicate: (query: { queryKey: readonly unknown[] }) => boolean;
  };
  expect(
    predicate({ queryKey: ['workspace', 'ws1', 'study', 'assignments'] })
  ).toBe(true);
  vi.useRealTimers();
});
