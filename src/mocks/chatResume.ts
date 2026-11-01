import { HttpResponse, http } from 'msw';
import { mockChatModel } from './chatFixtures';
import { chatMessages } from './db';
import { RUNNING_CHAT } from './editorSeed';

/** GET .../stream for a turn still running (T19). Only the e2e seed's turn
 * runs: its replay is the start and part of the answer, then the stream stays
 * open until the browser stops reading; any other turn answers 204, as the
 * server does for a turn that ended. */
export const mockResumeStream = http.get(
  '/api/conversations/:id/messages/:messageId/stream',
  ({ params }) => {
    const row = chatMessages.find(
      (msg) => msg.id === params.messageId && msg.status === 'streaming'
    );
    if (!row) return new HttpResponse(null, { status: 204 });
    const encoder = new TextEncoder();
    const events = [
      {
        ...mockChatModel,
        conversationId: row.conversationId,
        messageId: row.id,
        type: 'start',
      },
      { phase: 'answering', type: 'phase' },
      { blockId: 'b_running', type: 'block_start' },
      {
        blockId: 'b_running',
        text: RUNNING_CHAT.partialAnswer,
        type: 'block_delta',
      },
    ];
    // Never closed: the browser's Stop or departure cancels it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      },
    });
  }
);
