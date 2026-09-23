import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import { shouldApplyCitations, toChatMessage } from './useChatStream';

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
