import { afterEach, describe, expect, it, vi } from 'vitest';
import { undoPayload } from '@/lib/undoPayloads';
import {
  chatTurn,
  resumeChat,
  streamChat,
  WORKSPACE_ONLY_DEFAULT,
} from './chatStream';

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

// Epo 2026-10-21: an edit's Undo payload rides its tool_end. One of
// megabytes arrives whole across many reads and is kept for its receipt.
describe('the Undo payloads a tool_end carries', () => {
  it('keeps a large payload delivered in many reads', async () => {
    const update = 'A'.repeat(3 * 1024 * 1024);
    const payload = {
      actorUserId: 'u_1',
      documentId: 'mat_1',
      epoch: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      mac: 'f'.repeat(64),
      operationId: 'op_streamed',
      updates: { content: update },
    };
    const event = `data: ${JSON.stringify({
      callId: 'c1',
      endedAt: '2026-10-22T10:00:00Z',
      outcome: 'succeeded',
      type: 'tool_end',
      undoPayloads: [payload],
    })}

data: {"type":"done","status":"complete"}

`;
    const bytes = new TextEncoder().encode(event);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 64 * 1024)
          controller.enqueue(bytes.slice(at, at + 64 * 1024));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 }))
    );
    const ended = vi.fn();
    await streamChat(
      'ws_1',
      { text: 'Edit it', workspaceOnly: false },
      { onToolEnd: ended }
    );
    expect(ended).toHaveBeenCalledOnce();
    expect(await undoPayload('op_streamed')).toMatchObject(payload);
  });
});

/** The handler calls one streamed turn makes, in order. */
async function handled(events: object[]): Promise<string[]> {
  const body = events
    .map(
      (ev) => `data: ${JSON.stringify(ev)}

`
    )
    .join('');
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
  return seen;
}

describe('the waiting phase', () => {
  it('shows for each wait in a turn until the next event of any kind (Q300)', async () => {
    const seen = await handled([
      { conversationId: 'c_1', messageId: 'm_1', type: 'start' },
      { phase: 'waiting_limit', type: 'phase' },
      { blockId: 'b_1', type: 'block_start' },
      { phase: 'running_tools', type: 'phase' },
      { callId: 't_1', name: 'search', type: 'tool_start' },
      { phase: 'waiting_capacity', type: 'phase' },
      { callId: 't_1', outcome: 'succeeded', type: 'tool_end' },
      { status: 'complete', type: 'done' },
    ]);

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

  it('shows the phase the server sends when the slot arrives once (Q359)', async () => {
    const seen = await handled([
      { conversationId: 'c_1', messageId: 'm_1', type: 'start' },
      { phase: 'waiting_capacity', type: 'phase' },
      { phase: 'planning', type: 'phase' },
      { blockId: 'b_1', type: 'block_start' },
      { status: 'complete', type: 'done' },
    ]);

    expect(seen).toEqual([
      'start',
      'waiting_capacity',
      'planning',
      'block b_1',
      'done',
    ]);
  });
});

/** A response whose body sends `events` and then stays open. */
function openStream(events: object[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    },
  });
}

// Epo 2026-10-27, T19: a running turn is followed again after a reload or
// a dropped connection.
describe('following a turn', () => {
  it('reports a connection lost before the last event as a drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ conversationId: 'c_1', messageId: 'm_1', type: 'start' })}\n\n`
          )
      )
    );
    const onDrop = vi.fn();
    const onError = vi.fn();
    await streamChat(
      'ws_1',
      { text: 'hi', workspaceOnly: false },
      { onDrop, onError }
    );
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reads a running turn from its stream, and a turn that ended is gone', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const onGone = vi.fn();
    await resumeChat('c_1', 'm_1', { onGone });
    expect(onGone).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/conversations/c_1/messages/m_1/stream'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('stops reading at the last event though the response stays open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            openStream([
              { conversationId: 'c_1', messageId: 'm_1', type: 'start' },
              { status: 'aborted', type: 'done' },
            ])
          )
      )
    );
    const onDone = vi.fn();
    const onDrop = vi.fn();
    await resumeChat('c_1', 'm_1', { onDone, onDrop });
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted' })
    );
    expect(onDrop).not.toHaveBeenCalled();
  });
});
