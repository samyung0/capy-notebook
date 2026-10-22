import { afterEach, describe, expect, it, vi } from 'vitest';
import { undoPayload } from '@/lib/undoPayloads';
import { chatTurn, LIBRARY_DEFAULT, streamChat } from './chatStream';

describe('the per-turn chat body', () => {
  it('starts with the Library switch on', () => {
    expect(LIBRARY_DEFAULT).toBe(true);
    expect(chatTurn(LIBRARY_DEFAULT, null)).toEqual({
      library: true,
      openResource: undefined,
    });
  });

  it('sends the switch as set for this turn and only the open item id and kind', () => {
    const open = { id: 'f_1', kind: 'file' as const, title: 'Browser title' };
    expect(chatTurn(false, open)).toEqual({
      library: false,
      openResource: { id: 'f_1', kind: 'file' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Epo 2026-10-21: an edit's Undo payload rides its tool_end. One of
// megabytes arrives whole across many reads and is kept for its receipt.
describe('the Undo payloads a tool_end carries', () => {
  it('keeps a large payload delivered in many reads', async () => {
    const update = 'A'.repeat(3 * 1024 * 1024);
    const payload = {
      documentId: 'mat_1',
      epoch: 1,
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
      { library: true, text: 'Edit it' },
      { onToolEnd: ended }
    );
    expect(ended).toHaveBeenCalledOnce();
    expect(await undoPayload('op_streamed')).toMatchObject(payload);
  });
});
