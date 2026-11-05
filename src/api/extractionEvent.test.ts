import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { api, qk } from './client';
import { applyNotificationEvent, onExtractionEnd } from './hooks';
import type { Extraction } from './types';

it('reads a run that ended and refreshes its workspace materials', async () => {
  const ended: Extraction = {
    answered: 12,
    createdAt: '2026-11-04T10:00:00Z',
    id: 'ex_1',
    quizId: 'qz_1',
    recorded: 12,
    status: 'done',
    title: 'Past paper',
    workspaceId: 'ws_1',
  };
  vi.spyOn(api, 'get').mockResolvedValue(ended);
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const heard = vi.fn();
  const stop = onExtractionEnd(heard);
  applyNotificationEvent(qc, {
    extractionId: 'ex_1',
    status: 'done',
    type: 'extraction',
  });
  await vi.waitFor(() => expect(heard).toHaveBeenCalledWith(ended));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.materials('ws_1') });
  stop();
});
