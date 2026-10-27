import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { qk } from './client';
import { applyNotificationEvent } from './hooks';
import type { Conversation } from './types';

const conversation = (id: string): Conversation => ({
  createdAt: '2026-10-27T00:00:00Z',
  id,
  running: false,
  title: id,
  updatedAt: '2026-10-27T00:00:00Z',
  workspaceId: 'ws_1',
});

// Epo 2026-10-27, T19: a conversation answering in any tab is marked in the
// conversation lists, from the status its turn's start and end send.
describe('chat turn stream event', () => {
  it('marks the conversation running, then not, in every cached list', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.conversations('ws_1'), [
      conversation('c_1'),
      conversation('c_2'),
    ]);
    const running = () =>
      qc
        .getQueryData<Conversation[]>(qk.conversations('ws_1'))
        ?.filter((c) => c.running)
        .map((c) => c.id);

    applyNotificationEvent(qc, {
      conversationId: 'c_1',
      status: 'streaming',
      type: 'chat_turn',
    });
    expect(running()).toEqual(['c_1']);
    applyNotificationEvent(qc, {
      conversationId: 'c_1',
      status: 'complete',
      type: 'chat_turn',
    });
    expect(running()).toEqual([]);
  });

  it('refetches the lists for a turn in a conversation none holds yet', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.conversations('ws_1'), [conversation('c_1')]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyNotificationEvent(qc, {
      conversationId: 'c_new',
      status: 'streaming',
      type: 'chat_turn',
    });
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
