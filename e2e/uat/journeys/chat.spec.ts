/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Chat on the deployed stack: one real turn validates the chat slot's catalog
// row and its EliteLLM route; two scripted turns then call every chat tool
// that UAT can run, deterministically and without a model (UAT's
// RETRIEVAL_UAT_SCRIPTED_TOOLS, pipeline/pipeline/retrieval/scripted.py). The
// scripted calls run as a model's would, under the owner's operations and the
// contract's validation, against the real workspace, index and gateway.
//
// Not called: the library tools (search_library, read_library,
// capture_library_page), because UAT has no knowledge library, and
// search_web, which charges per search, so Workspace only is on; create_deck
// and write_slide, because a stored deck enqueues a paid
// parse and index; resolve_source_change, whose result UAT cannot see (the
// Agent visibility lane checks it, pipeline/tests/stack, Q534).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { showPanelView } from '../../helpers/panelView';
import { m } from '../../i18n';
import { citations, type Frame, scripted, send } from './chat';
import {
  fixture,
  processed,
  settledSessions,
  string,
  upload,
  workspace,
} from './files';
import {
  type CatalogRow,
  onRow,
  type ProviderCall,
  rerankOnRow,
  sessionCalls,
  slotDefault,
} from './models';
import { contentText, materialRow } from './note';
import { expect, test, type UatRun } from './runtime';

type Effect = { operation: string; resource: { id: string; kind: string } };

/** The resource a write's tool_end reports for `operation`. */
function effect(end: Frame | undefined, operation: string) {
  const found = ((end?.effects ?? []) as Effect[]).find(
    (item) => item.operation === operation
  );
  // Only the effects: an edit's tool_end also carries its signed Undo
  // payloads (durable Undo), which stay out of failure messages.
  assert(found, `no ${operation} effect in ${JSON.stringify(end?.effects)}`);
  return found.resource.id;
}

/** Question ids of a quiz's projected content, in order. */
function questionIds(content: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    const question = value.question as { id?: unknown } | undefined;
    if (value.type === 'quiz_question' && typeof question?.id === 'string')
      ids.push(question.id);
    walk(value.children);
    walk(value.value);
  };
  walk(content);
  return ids;
}

const kind = (calls: ProviderCall[], name: string) =>
  calls.filter((call) => call.kind === name);

/** A session's or workspace's pinned model as a catalog row. */
const pinned = (row: Record<string, unknown>, prefix: string): CatalogRow => ({
  model_slug: string(row[`${prefix}_model_slug`]),
  provider_slug: string(row[`${prefix}_provider_slug`]),
  version: Number(row[`${prefix}_model_version`]),
});

const same = (row: CatalogRow | undefined) => {
  assert(row);
  return { ...row, version: Number(row.version) };
};

async function materialPolled(
  run: UatRun,
  id: string,
  label: string,
  texts: string[]
) {
  return run.poll(
    label,
    () => contentText(run, id),
    (text) => texts.every((item) => text.includes(item))
  );
}

test('chat: a real turn on the chat default, then every runnable tool from scripted turns', async ({
  run,
}) => {
  test.setTimeout(2_400_000);
  const page = run.owner.page;
  const workspaceId = await workspace(run, 'chat');
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  // Two sources, so a search has more than one candidate to rerank.
  const pdf = await upload(
    run,
    workspaceId,
    'digital.pdf',
    await fixture('digital.pdf', 'unused')
  );
  const text = await upload(
    run,
    workspaceId,
    'notes.txt',
    await fixture('notes.txt', marker)
  );
  await processed(run, pdf, ['LARCH-17']);
  await processed(run, text, [marker]);

  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await showPanelView(page, m.workspace_tab_chat());
  // The scope menu's button names the scope in use; it starts on all.
  await page
    .getByRole('button', { exact: true, name: m.chat_all_sources() })
    .click();
  await page.getByRole('menuitem', { name: m.chat_workspace_only() }).click();
  await expect(
    page.getByRole('button', { exact: true, name: m.chat_workspace_only() })
  ).toBeVisible();

  // The real turn: the content is the model's own; only the route is checked.
  const chat = await slotDefault(run, 'chat');
  assert(chat);
  const real = await send(page, 'Say hello in one short sentence.');
  const start = real.find((frame) => frame.type === 'start');
  assert.deepEqual(
    [start?.providerSlug, start?.modelSlug, start?.modelVersion],
    [chat.provider_slug, chat.model_slug, Number(chat.version)]
  );

  // Scripted turn 1: every read, the skills, then the first writes.
  const note = `Scripted note ${marker}.\n\nThe launch code is LARCH-17.`;
  const first = await scripted(page, [
    [
      { arguments: {}, name: 'list_sources' },
      { arguments: { query: 'launch code' }, name: 'search_workspace' },
      { arguments: { name: 'editing' }, name: 'read_skill' },
      { arguments: { name: 'note_building' }, name: 'read_skill' },
    ],
    [
      { arguments: { file_id: pdf }, name: 'read_document' },
      { arguments: {}, name: 'read_study_progress' },
      { arguments: {}, name: 'list_trashed_files' },
    ],
    [
      // read_document numbered the PDF's page 1 passage, so it may be captured.
      { arguments: { file_id: pdf, page: 1 }, name: 'capture_page' },
      {
        arguments: { content: note, kind: 'note', title: 'Scripted note' },
        name: 'create_material',
      },
      {
        arguments: {
          questions: [
            {
              correct: 'LARCH-17',
              options: ['LARCH-17', 'CEDAR-42'],
              question: 'Which launch code does the PDF give?',
            },
          ],
          title: 'Scripted quiz',
        },
        name: 'add_questions',
      },
      {
        arguments: {
          cards: [{ back: 'LARCH-17', front: 'Launch code' }],
          kind: 'flashcards',
          title: 'Scripted cards',
        },
        name: 'create_material',
      },
    ],
    'Scripted tools ran. [#1]',
  ]);
  // The answer cites passage 1, a chunk of one of the two sources.
  const cited = citations(first.frames);
  assert(cited.length, 'the answer has no citations');
  assert.equal(cited[0].n, 1);
  assert([pdf, text].includes(cited[0].fileId));
  const noteId = effect(first.ends[8], 'created');
  const quizId = effect(first.ends[9], 'created');
  const cardsId = effect(first.ends[10], 'created');
  for (const [id, expected] of [
    [noteId, 'note'],
    [quizId, 'quiz'],
    [cardsId, 'flashcards'],
  ]) {
    const row = await materialRow(run, id);
    assert.deepEqual(
      [row.kind, row.workspace_id, row.created_by],
      [expected, workspaceId, run.owner.id]
    );
  }
  await materialPolled(run, noteId, 'scripted note', [
    `Scripted note ${marker}.`,
  ]);
  await materialPolled(run, quizId, 'scripted quiz', ['CEDAR-42']);
  await materialPolled(run, cardsId, 'scripted cards', ['Launch code']);
  const [questionId] = questionIds((await materialRow(run, quizId)).content);
  assert(questionId, 'the quiz has no question');

  // Scripted turn 2: inspect and edit what turn 1 made, then trash and restore.
  const second = await scripted(page, [
    [
      { arguments: { name: 'editing' }, name: 'read_skill' },
      { arguments: { name: 'note_building' }, name: 'read_skill' },
      {
        arguments: { target: { id: noteId, kind: 'material' } },
        name: 'inspect_document',
      },
    ],
    [
      {
        arguments: {
          commands: [
            {
              after_block_id: null,
              markdown: `Scripted insert ${marker}.`,
              type: 'insert_markdown',
            },
          ],
          target: { id: noteId, kind: 'material' },
        },
        name: 'edit_document',
      },
      {
        arguments: {
          questions: [
            {
              marks: 1,
              markscheme: [{ marks: 1, text: 'Names LARCH-17.' }],
              model_answer: 'The PDF gives the launch code LARCH-17.',
              question:
                'Which launch code does the PDF give, and why does it matter?',
            },
          ],
          quiz_id: quizId,
        },
        name: 'add_questions',
      },
      {
        arguments: {
          media: {
            kind: 'bar',
            labels: ['LARCH', 'CEDAR'],
            series: [{ name: 'Codes', values: [17, 42] }],
            title: 'Scripted chart',
            type: 'chart',
          },
          question_id: questionId,
          quiz_id: quizId,
        },
        name: 'add_question_media',
      },
    ],
    [
      {
        arguments: { target: { id: cardsId, kind: 'material' } },
        name: 'trash_file',
      },
      {
        arguments: { target: { id: cardsId, kind: 'material' } },
        name: 'restore_file',
      },
    ],
    'Scripted edits ran.',
  ]);
  assert.deepEqual(
    [
      effect(second.ends[3], 'edited'),
      effect(second.ends[4], 'edited'),
      effect(second.ends[5], 'edited'),
      effect(second.ends[6], 'trashed'),
      effect(second.ends[7], 'restored'),
    ],
    [noteId, quizId, quizId, cardsId, cardsId]
  );
  await materialPolled(run, noteId, 'scripted note edit', [
    `Scripted insert ${marker}.`,
    `Scripted note ${marker}.`,
  ]);
  await materialPolled(run, quizId, 'scripted quiz edits', [
    '"type":"open"',
    'Names LARCH-17.',
    '"type":"chart"',
    'Scripted chart',
  ]);
  const cards = await run.query(
    'SELECT trashed_at,trash_restores FROM materials WHERE id=%s',
    [cardsId]
  );
  assert.deepEqual(
    [cards[0]?.trashed_at, Number(cards[0]?.trash_restores)],
    [null, 1]
  );

  // Spend: one session per turn, each settled. The real turn's model calls
  // ran on the chat default; the scripted turns made none, and turn 1's one
  // search embedded its query on the workspace pin and reranked with the
  // rerank default (absent only when an operator cleared it).
  const sessions = await settledSessions(
    run,
    `${workspaceId}-chat`,
    `provider_sessions p WHERE p.workspace_id=%s AND p.surface='chat'`,
    [workspaceId],
    false,
    true
  );
  assert.equal(sessions.length, 3);
  const retrieval = await slotDefault(run, 'retrieval');
  const rerank = await slotDefault(run, 'rerank');
  const [workspacePin] = await run.query(
    'SELECT embedding_provider_slug,embedding_model_slug,embedding_model_version FROM workspaces WHERE id=%s',
    [workspaceId]
  );
  const pin = pinned(workspacePin, 'embedding');
  assert.deepEqual(pin, same(retrieval));
  const rows = await run.query(
    `SELECT id,llm_provider_slug,llm_model_slug,llm_model_version,embedding_provider_slug,
    embedding_model_slug,embedding_model_version FROM provider_sessions WHERE workspace_id=%s AND surface='chat'`,
    [workspaceId]
  );
  for (const row of rows) {
    assert.deepEqual(pinned(row, 'llm'), same(chat));
    assert.deepEqual(pinned(row, 'embedding'), pin);
  }
  const [answered, reads, edits] = await Promise.all(
    sessions.map((session) => sessionCalls(run, string(session.id)))
  );
  assert(kind(answered, 'llm').length > 0, 'the real turn called no model');
  assert(
    answered.every((call) => ['llm', 'embedding', 'rerank'].includes(call.kind))
  );
  onRow(kind(answered, 'llm'), chat, true);
  onRow(kind(answered, 'embedding'), pin, false);
  // A rerank may time out (open or receipt_timeout, uncharged); every other
  // call must be applied.
  const toleratedReranks = rerank
    ? rerankOnRow(kind(answered, 'rerank'), rerank)
    : [];
  if (!rerank) assert.equal(kind(answered, 'rerank').length, 0);
  assert.deepEqual(
    reads.map((call) => call.kind).sort(),
    rerank ? ['embedding', 'rerank'] : ['embedding']
  );
  onRow(kind(reads, 'embedding'), pin, false);
  if (rerank)
    toleratedReranks.push(...rerankOnRow(kind(reads, 'rerank'), rerank));
  assert.deepEqual(edits, [], 'the second scripted turn made a provider call');
  await run.attach(`${workspaceId}-chat`, {
    answered,
    cited,
    reads,
    sessions: rows,
    toleratedReranks,
  });
});
