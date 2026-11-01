import { delay, HttpResponse, http } from 'msw';
import type { ChatStreamBody } from '@/api/chatStream';
import { createConversationBodyTitleMax } from '@/api/gen/validators';
import type {
  ActivityBlock,
  ResourceEffect,
  ResourceEffectOperation,
} from '@/api/types';
import {
  type ChatFixture,
  chatFixtures,
  type FixtureEdit,
  fixtureCitations,
  fixtureResult,
  mockChatModel,
} from './chatFixtures';
import { mockUndoPayload, rememberUndo } from './chatUndo';
import { chatMessages, conversations, files, materials, uid } from './db';

type MockTool = Extract<ActivityBlock, { kind: 'tool' }>;
type MockStep = Pick<MockTool, 'capture' | 'detail' | 'name'>;

/** An effect with a fresh undo ref, for the mock Undo endpoint to answer. */
function undoable(
  operation: ResourceEffectOperation,
  kind: 'source_file' | 'material',
  item: { id: string; title: string },
  materialKind?: string
): ResourceEffect {
  const operationId = uid('op');
  return {
    operation,
    operationId,
    resource: { id: item.id, kind, materialKind, title: item.title },
    undo: { operationId, status: 'available' },
  };
}

/** A fixture's change to a mock file or material, by id. */
function fixtureEffect(
  change: FixtureEdit['changes'][number]
): ResourceEffect[] {
  const file = files.find(({ id }) => id === change.id);
  const material = materials.find(({ id }) => id === change.id);
  const effect = file
    ? undoable(change.operation, 'source_file', {
        id: file.id,
        title: file.name,
      })
    : material
      ? undoable(change.operation, 'material', material, material.kind)
      : undefined;
  if (!effect?.undo) return [];
  if (change.undo === 'none') return [{ ...effect, undo: undefined }];
  return [effect];
}

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
            await delay(900);
            if (stopped()) return;
            send({ phase: 'running_tools', type: 'phase' });
            const workspaceFiles = files.filter(
              (file) => file.workspaceId === params.id
            );
            // Office edits cut at a per-call limit, by file id: each row
            // stays in progress until the next edit of its file lands, or
            // the turn's end closes it with its counts.
            const cuts = new Map<string, MockTool>();
            const close = (tool: MockTool) =>
              send({
                applied: tool.applied,
                callId: tool.callId,
                effects: tool.effects,
                endedAt: tool.endedAt,
                outcome: tool.outcome,
                total: tool.total,
                type: 'tool_end',
              });
            const run = async (
              step: MockStep,
              ms: number,
              effects?: ResourceEffect[],
              cut?: FixtureEdit['cut']
            ) => {
              const tool: MockTool = {
                ...step,
                callId: uid('call'),
                id: '',
                kind: 'tool',
                startedAt: new Date().toISOString(),
              };
              tool.id = tool.callId;
              activity.push(tool);
              send({
                callId: tool.callId,
                detail: tool.detail,
                name: tool.name,
                startedAt: tool.startedAt,
                type: 'tool_start',
              });
              await delay(ms);
              tool.endedAt = new Date().toISOString();
              if (stopped()) {
                tool.outcome = 'cancelled';
                return false;
              }
              tool.outcome = 'succeeded';
              tool.effects = effects;
              for (const effect of effects ?? []) rememberUndo(effect);
              const file =
                step.name === 'edit_office_document'
                  ? effects?.[0]?.resource.id
                  : undefined;
              const earlier = file ? cuts.get(file) : undefined;
              if (cut && file) {
                Object.assign(tool, cut);
                cuts.set(file, tool);
                send({ ...cut, callId: tool.callId, type: 'tool_progress' });
              } else {
                if (file) cuts.delete(file);
                send({
                  callId: tool.callId,
                  effects,
                  endedAt: tool.endedAt,
                  outcome: tool.outcome,
                  type: 'tool_end',
                  undoPayloads: (effects ?? []).flatMap(
                    (effect) => mockUndoPayload(effect) ?? []
                  ),
                });
              }
              if (earlier) {
                delete earlier.applied;
                delete earlier.total;
                close(earlier);
              }
              return true;
            };
            // A turn that searches, reads, looks at a page, narrates, asks
            // the library, then creates a quiz and edits a file with Undo.
            const steps: [MockStep, number, ResourceEffect[]?][] = [
              [
                { detail: body.text.slice(0, 40), name: 'search_workspace' },
                700,
              ],
              [
                {
                  detail: workspaceFiles[0]?.name ?? 'Cell structure.pdf',
                  name: 'read_document',
                },
                800,
              ],
              [
                {
                  capture: { bbox: null, bytes: 182_000, page: 2 },
                  detail: 'page 2',
                  name: 'capture_page',
                },
                600,
              ],
            ];
            for (const [step, ms, effects] of steps) {
              if (!(await run(step, ms, effects))) return;
            }
            const narration = uid('block');
            send({ blockId: narration, type: 'block_start' });
            const said =
              "Your notes cover this. I'll check the textbook too, then make a quick quiz.";
            send({ blockId: narration, text: said, type: 'block_delta' });
            send({ blockId: narration, kind: 'narration', type: 'block_end' });
            activity.push({ id: narration, kind: 'narration', text: said });
            await delay(700);
            if (stopped()) return;
            if (selected.edits) {
              for (const edit of selected.edits) {
                const effects = edit.changes.flatMap(fixtureEffect);
                const detail = effects
                  .map(({ resource }) => resource.title)
                  .join(', ');
                if (
                  !(await run(
                    { detail, name: edit.tool },
                    800,
                    effects,
                    edit.cut
                  ))
                )
                  return;
                // The model reads the cut call's result before sending the rest.
                if (edit.cut) await delay(2500);
              }
            }
            const quiz = materials.find((item) => item.id === 'qz_1');
            const note = workspaceFiles.find((file) => file.id === 'f_2');
            const later: [MockStep, number, ResourceEffect[]?][] = [
              [{ detail: 'water potential', name: 'search_library' }, 600],
              [
                { detail: quiz?.title, name: 'create_material' },
                900,
                quiz && [undoable('created', 'material', quiz, 'quiz')],
              ],
              [
                { detail: quiz?.title, name: 'add_questions' },
                700,
                quiz && [
                  {
                    ...undoable('edited', 'material', quiz, 'quiz'),
                    undo: undefined,
                  },
                ],
              ],
            ];
            for (const [step, ms, effects] of selected.edits ? [] : later) {
              if (!(await run(step, ms, effects))) return;
            }
            await delay(600);
            if (stopped()) return;
            if (
              !selected.edits &&
              note &&
              !(await run({ detail: note.name, name: 'edit_document' }, 900, [
                undoable('edited', 'source_file', {
                  id: note.id,
                  title: note.name,
                }),
              ]))
            )
              return;
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
            if (!selected.closeEarly) {
              for (const tool of cuts.values()) close(tool);
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
            if (conversations.includes(current))
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
