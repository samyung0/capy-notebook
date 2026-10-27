import { delay, HttpResponse, http } from 'msw';
import type { ChatStreamBody } from '@/api/chatStream';
import { createConversationBodyTitleMax } from '@/api/gen/validators';
import type { ActivityBlock, Citation, Conversation } from '@/api/types';
import { mockChatModel } from './chatFixtures';
import { chatMessages, conversations, files, uid, workspaces } from './db';

/** An account chat's citations: one Biology 101 file and one standalone file,
 * each naming where it lives as the account tools do. */
export function accountCitations(): Citation[] {
  const cited = ['f_2', 'f_standalone_md'].flatMap((id) => {
    const file = files.find((item) => item.id === id);
    return file ? [file] : [];
  });
  return cited.map((file, index) => ({
    fileId: file.id,
    fileName: file.name,
    n: index + 1,
    snippet:
      file.id === 'f_standalone_md'
        ? 'Finish one a month; notes go in the study group folder.'
        : 'Mitochondria transfer energy from food into ATP.',
    workspaceId: file.workspaceId,
    workspaceName:
      workspaces.find((workspace) => workspace.id === file.workspaceId)?.name ??
      '',
  }));
}

const answer =
  'root = Answer([Md("Your Biology 101 cheatsheet covers the organelles, and your reading list has *The Selfish Gene* for this month, which fits the genetics unit.", [1, 2])])';

/** The account conversations list and create, and the account chat stream: a
 * canned turn that searches and reads across the user's files, then answers
 * citing a workspace file and a standalone one. */
export const accountChatHandlers = [
  http.get('/api/conversations', ({ request }) => {
    const archived =
      new URL(request.url).searchParams.get('archived') === 'true';
    const time = (at?: string) => (at ? +new Date(at) : 0);
    const list = conversations
      .filter((c) => c.workspaceId === '' && !!c.archivedAt === archived)
      .sort((a, b) =>
        archived
          ? time(b.archivedAt) - time(a.archivedAt)
          : time(b.pinnedAt) - time(a.pinnedAt) ||
            time(b.updatedAt) - time(a.updatedAt)
      );
    return HttpResponse.json(list);
  }),
  http.post('/api/conversations', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
    };
    const now = new Date().toISOString();
    const conversation: Conversation = {
      createdAt: now,
      id: uid('conv'),
      title: body.title ?? '',
      updatedAt: now,
      workspaceId: '',
    };
    conversations.push(conversation);
    return HttpResponse.json(conversation, { status: 201 });
  }),
  http.post('/api/chat/stream', async ({ request }) => {
    const body = (await request.json()) as ChatStreamBody;
    const now = new Date().toISOString();
    let conversation = body.conversationId
      ? conversations.find((item) => item.id === body.conversationId)
      : undefined;
    if (!conversation) {
      conversation = {
        createdAt: now,
        id: uid('conv'),
        title: [...body.text].slice(0, createConversationBodyTitleMax).join(''),
        updatedAt: now,
        workspaceId: '',
      };
      conversations.push(conversation);
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
    const current = conversation;
    const citations = accountCitations();
    const messageId = uid('m');
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
          if (!stopped())
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
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
          await delay(600);
          send({ phase: 'running_tools', type: 'phase' });
          for (const [name, detail] of [
            ['search_files', body.text.slice(0, 40)],
            ['read_document', 'Reading list.md'],
          ]) {
            const callId = uid('call');
            const startedAt = new Date().toISOString();
            send({ callId, detail, name, startedAt, type: 'tool_start' });
            await delay(600);
            if (stopped()) return;
            const endedAt = new Date().toISOString();
            activity.push({
              callId,
              detail,
              endedAt,
              id: callId,
              kind: 'tool',
              name,
              outcome: 'succeeded',
              startedAt,
            });
            send({ callId, endedAt, outcome: 'succeeded', type: 'tool_end' });
          }
          send({ citations, type: 'citations', version: 1 });
          send({ phase: 'answering', type: 'phase' });
          send({ blockId, type: 'block_start' });
          for (let offset = 0; offset < answer.length; offset += 40) {
            await delay(35);
            if (stopped()) return;
            const text = answer.slice(offset, offset + 40);
            content += text;
            send({ blockId, text, type: 'block_delta' });
          }
          send({ blockId, kind: 'answer', type: 'block_end' });
          send({
            status: 'complete',
            tokenCount: Math.ceil(content.length / 4),
            type: 'done',
          });
        } finally {
          if (conversations.includes(current))
            chatMessages.push({
              ...mockChatModel,
              activity,
              citations,
              content,
              conversationId: current.id,
              createdAt: new Date().toISOString(),
              id: messageId,
              role: 'assistant',
              status: stopped() ? 'aborted' : 'complete',
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
  }),
];
