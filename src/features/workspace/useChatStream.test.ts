import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { m } from '@/i18n';
import {
  shouldApplyCitations,
  toChatMessage,
  turnStopper,
} from './useChatStream';

describe('shouldApplyCitations', () => {
  it('keeps a later version and ignores an older one', () => {
    expect(shouldApplyCitations(2, 1)).toBe(true);
    expect(shouldApplyCitations(1, 1)).toBe(true);
    expect(shouldApplyCitations(0, 1)).toBe(false);
  });
});

it('restores the safety notice from a persisted error code', () => {
  const message = toChatMessage({
    content: '',
    conversationId: 'c1',
    createdAt: '2026-09-22T00:00:00Z',
    errorCode: 'response_flagged',
    id: 'm1',
    role: 'assistant',
    status: 'error',
  });
  expect(message.error).toBe(m.chat_response_flagged());
  expect(message.content).toBe('');
});

describe('turnStopper', () => {
  const ids = { conversationId: 'c1', messageId: 'm1' };

  it('asks the server to stop the named turn, then stops reading', async () => {
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push('request');
    });
    const stopper = turnStopper(request, () => order.push('abort'));
    stopper.stop(); // before the server named the turn
    expect(request).not.toHaveBeenCalled();
    stopper.named(ids);
    await vi.waitFor(() => expect(order).toEqual(['request', 'abort']));
    expect(request).toHaveBeenCalledWith(ids);
  });

  it('stops reading when the request cannot reach the server', async () => {
    const abort = vi.fn();
    const stopper = turnStopper(
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      abort
    );
    stopper.named(ids);
    stopper.stop();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
  });

  it('keeps reading when the server refuses, for another press', async () => {
    const abort = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, 'Internal Server Error'))
      .mockResolvedValueOnce(undefined);
    const stopper = turnStopper(request, abort);
    stopper.named(ids);
    stopper.stop();
    stopper.stop(); // a second press while the first is in flight
    await new Promise((resolve) => setTimeout(resolve, 0)); // the refusal lands
    expect(request).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    stopper.stop();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(2);
  });
});
