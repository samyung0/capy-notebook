import 'fake-indexeddb/auto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { getMaterialCollaborationToken } from '@/api/hooks';
import type {
  ChatMessage,
  OperationReceipt,
  ResourceEffect,
} from '@/api/types';
import { m } from '@/i18n';
import { localUndoPayload } from '@/lib/localDb';
import { keepUndoPayloads, undoPayload } from '@/lib/undoPayloads';
import { ChatTrace, type UndoHandlers } from './ChatTrace';

// No DOM: each render records the buttons' props, and the test calls onClick.
const buttons = vi.hoisted(
  () => [] as { children?: unknown; onClick?: () => void }[]
);
vi.mock('@/components/ui/Button', async (original) => ({
  ...(await original<typeof import('@/components/ui/Button')>()),
  Button: (props: (typeof buttons)[number]) => {
    buttons.push(props);
    return null;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 20, 12, 0, s)).toISOString();

const payload = (operationId: string) => ({
  documentId: 'mat_1',
  epoch: 1,
  mac: 'f'.repeat(64),
  operationId,
  updates: { content: 'dW5kbw==' },
});

/** The Undo button of an edit's receipt, if it shows one. */
function maybeUndoButton(handlers: UndoHandlers, id: string) {
  const edit: ResourceEffect = {
    operation: 'edited',
    operationId: id,
    resource: { id: 'mat_1', kind: 'material', title: 'Cells' },
    undo: { operationId: id, status: 'available' },
  };
  const msg = {
    activity: [
      {
        callId: 'c1',
        effects: [edit],
        endedAt: at(2),
        id: 'c1',
        kind: 'tool',
        name: 'edit_document',
        outcome: 'succeeded',
        startedAt: at(1),
      },
    ],
    content: 'Done.',
    createdAt: at(0),
    id: 'm1',
    role: 'assistant',
    status: 'complete',
  } as ChatMessage;
  buttons.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTrace handlers={handlers} live={false} mode="verbose" msg={msg} />
    </QueryClientProvider>
  );
  return buttons.find(({ children }) => children === m.chat_undo_edit())
    ?.onClick;
}

function undoButton(handlers: UndoHandlers, id: string) {
  const click = maybeUndoButton(handlers, id);
  if (!click) throw new Error('no Undo button');
  return click;
}

const handlers = () => ({
  onUndoApplied: vi.fn(),
  onUndoRefused: vi.fn(),
});

it('sends one Undo, with its payload, for two clicks while the first is out', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockReturnValue(new Promise<OperationReceipt>(() => {}));
  keepUndoPayloads([payload('op_two_clicks')]);
  const click = undoButton(handlers(), 'op_two_clicks');
  click();
  click();
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0][1]).toMatchObject({
    payload: payload('op_two_clicks'),
  });
});

// Epo 2026-10-21: an edit's Undo is its payload; with none kept (a lost
// stream, blocked storage, a day gone by) the receipt offers no Undo.
it('offers no Undo on an edit whose payload the browser does not hold', () => {
  expect(maybeUndoButton(handlers(), 'op_no_payload')).toBeUndefined();
});

// Q122 (Epo 2026-10-22): once a token shows the document in a newer
// lineage, its payload goes and the receipt shows no Undo, rather than one
// that fails on click.
it('offers no Undo once the document moved to a newer lineage', async () => {
  keepUndoPayloads([payload('op_compacted')]);
  await vi.waitFor(async () =>
    expect(await localUndoPayload('op_compacted')).toBeDefined()
  );
  expect(maybeUndoButton(handlers(), 'op_compacted')).toBeDefined();
  vi.spyOn(api, 'post').mockResolvedValue({
    room: 'material:mat_1:schema:2',
  });
  await getMaterialCollaborationToken('mat_1');
  expect(maybeUndoButton(handlers(), 'op_compacted')).toBeUndefined();
  await vi.waitFor(async () =>
    expect(await localUndoPayload('op_compacted')).toBeUndefined()
  );
});

// Redo across a room close (Epo 2026-10-21): the Undo's answer brings the
// Redo payload, which is kept, and the used payload goes.
it("keeps the Undo's Redo payload and drops the used one", async () => {
  const next = { ...payload('op_redo'), operationId: 'op_redo' };
  vi.spyOn(api, 'post').mockResolvedValue({
    effect: {
      operation: 'edit_undone',
      operationId: 'op_redo',
      resource: { id: 'mat_1', kind: 'material', title: 'Cells' },
      undo: { operationId: 'op_redo', status: 'available' },
    },
    kind: 'undo_edit',
    operationId: 'op_redo',
    outcome: 'succeeded',
    toolVersion: 1,
    undoPayload: next,
  } satisfies OperationReceipt);
  keepUndoPayloads([payload('op_undo')]);
  undoButton(handlers(), 'op_undo')();
  await vi.waitFor(async () =>
    expect(await undoPayload('op_redo')).toMatchObject(next)
  );
  expect(await undoPayload('op_undo')).toBeUndefined();
});
