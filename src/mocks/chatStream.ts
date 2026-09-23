import { delay, HttpResponse, http } from 'msw';
import type { ChatStreamBody } from '@/api/chatStream';
import { createConversationBodyTitleMax } from '@/api/gen/validators';
import type { ActivityBlock } from '@/api/types';
import {
  type ChatFixture,
  chatFixtures,
  fixtureCitations,
  fixtureResult,
  mockChatModel,
} from './chatFixtures';
import { chatMessages, conversations, files, uid } from './db';

/** All rich-chat previews use the same persistence and SSE path as the default mock. */
export function mockChatStream(fixture?: ChatFixture) {
  return http.post(
    '/api/workspaces/:id/chat/stream',
    async ({ params, request }) => {
      const body = (await request.json()) as ChatStreamBody;
      const now = new Date().toISOString();
      let conversation = body.conversationId
        ? conversations.find((item) => item.id === body.conversationId)
        : undefined;
      if (!conversation) {
        conversation = {
          createdAt: now,
          curate: body.curate,
          id: uid('conv'),
          title: '',
          updatedAt: now,
          workspaceId: String(params.id),
        };
        conversations.push(conversation);
      }
      if (!conversation.title) {
        conversation.title = [...body.text]
          .slice(0, createConversationBodyTitleMax)
          .join('');
      }
      chatMessages.push({
        citations: null,
        content: body.text,
        conversationId: conversation.id,
        createdAt: now,
        id: uid('m'),
        role: 'user',
        status: 'complete',
      });

      const selected: ChatFixture = fixture ?? chatFixtures[0];
      const citations = fixtureCitations(
        selected,
        files.filter((file) => file.workspaceId === params.id)
      );
      const current = conversation;
      const messageId = uid('m');
      const callId = uid('call');
      const blockId = uid('block');
      const encoder = new TextEncoder();
      let cancelled = false;
      const stopped = () => cancelled || request.signal.aborted;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        async start(controller) {
          const send = (event: unknown) => {
            if (!stopped()) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
              );
            }
          };
          const activity: ActivityBlock[] = [];
          let content = '';
          try {
            send({
              ...mockChatModel,
              conversationId: current.id,
              messageId,
              type: 'start',
            });
            send({ phase: 'planning', type: 'phase' });
            await delay(120);
            if (stopped()) return;
            send({ phase: 'running_tools', type: 'phase' });
            const tool: ActivityBlock = {
              callId,
              detail: body.text.slice(0, 40),
              id: callId,
              kind: 'tool',
              name: 'search_workspace',
            };
            activity.push(tool);
            send({
              callId,
              detail: tool.detail,
              name: tool.name,
              type: 'tool_start',
            });
            await delay(160);
            if (stopped()) {
              tool.outcome = 'cancelled';
              return;
            }
            tool.outcome = 'succeeded';
            send({ callId, outcome: tool.outcome, type: 'tool_end' });
            send({ citations, type: 'citations', version: 1 });
            send({ phase: 'answering', type: 'phase' });
            send({ blockId, type: 'block_start' });
            const chunkSize = selected.slow ? 12 : 40;
            for (
              let offset = 0;
              offset < selected.content.length;
              offset += chunkSize
            ) {
              await delay(selected.slow ? 150 : 35);
              if (stopped()) return;
              const text = selected.content.slice(offset, offset + chunkSize);
              content += text;
              send({ blockId, text, type: 'block_delta' });
            }
            if (selected.errorCode) {
              // The gateway sends the guard's error, never the detected tool markup.
              if (selected.errorCode === 'response_flagged') await delay(700);
              send({ code: selected.errorCode, type: 'error' });
            } else if (!selected.closeEarly) {
              send({ blockId, kind: 'answer', type: 'block_end' });
              send({ citations, type: 'citations', version: 2 });
              send({
                status: 'complete',
                tokenCount: Math.ceil(content.length / 4),
                type: 'done',
              });
            }
          } finally {
            const result = fixtureResult(selected, content, stopped());
            chatMessages.push({
              ...mockChatModel,
              ...result,
              activity,
              citations:
                result.errorCode === 'response_flagged' ? [] : citations,
              conversationId: current.id,
              createdAt: new Date().toISOString(),
              id: messageId,
              role: 'assistant',
            });
            current.updatedAt = new Date().toISOString();
            if (!cancelled) controller.close();
          }
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
}
