import { describe, expect, it } from 'vitest';
import { consumeSSE } from './sse';

describe('consumeSSE', () => {
  it('reassembles events split across response chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ': connected\n\n',
      'event: notification\ndata: {"type":"created"}\n',
      '\ndata: {"type":"read","ids":["nt_1"]}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events: string[] = [];

    await consumeSSE(body, (event) => events.push(event));

    expect(events).toEqual([
      ': connected',
      'event: notification\ndata: {"type":"created"}',
      'data: {"type":"read","ids":["nt_1"]}',
    ]);
  });
});
