import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatTurn, streamChat, WORKSPACE_ONLY_DEFAULT } from './chatStream';

vi.mock('./auth', () => ({
  authHeaders: async () => ({ Authorization: 'Bearer token' }),
  USE_MSW: false,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the per-turn chat body', () => {
  it('starts with Workspace only off', () => {
    expect(WORKSPACE_ONLY_DEFAULT).toBe(false);
    expect(chatTurn(WORKSPACE_ONLY_DEFAULT, null)).toEqual({
      openResource: undefined,
      workspaceOnly: false,
    });
  });

  it('sends the switch as set for this turn and only the open item id and kind', () => {
    const open = { id: 'f_1', kind: 'file' as const, title: 'Browser title' };
    expect(chatTurn(true, open)).toEqual({
      openResource: { id: 'f_1', kind: 'file' },
      workspaceOnly: true,
    });
  });
});

describe('the waiting phase', () => {
  it('shows for each wait in a turn until the next event of any kind (Q300)', async () => {
    const events = [
      { conversationId: 'c_1', messageId: 'm_1', type: 'start' },
      { phase: 'waiting_limit', type: 'phase' },
      { blockId: 'b_1', type: 'block_start' },
      { phase: 'running_tools', type: 'phase' },
      { callId: 't_1', name: 'search', type: 'tool_start' },
      { phase: 'waiting_capacity', type: 'phase' },
      { callId: 't_1', outcome: 'succeeded', type: 'tool_end' },
      { status: 'complete', type: 'done' },
    ];
    const body = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    const seen: string[] = [];

    await streamChat(
      'ws_1',
      { text: 'hi', workspaceOnly: false },
      {
        onBlockStart: (id) => seen.push(`block ${id}`),
        onDone: () => seen.push('done'),
        onPhase: (phase) => seen.push(phase),
        onStart: () => seen.push('start'),
        onToolEnd: (id) => seen.push(`end ${id}`),
        onToolStart: (id) => seen.push(`tool ${id}`),
      }
    );

    expect(seen).toEqual([
      'start',
      'waiting_limit',
      'planning',
      'block b_1',
      'running_tools',
      'tool t_1',
      'waiting_capacity',
      'running_tools',
      'end t_1',
      'done',
    ]);
  });
});
