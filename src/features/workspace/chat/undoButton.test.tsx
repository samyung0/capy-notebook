import 'fake-indexeddb/auto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/api/client';
import { getMaterialCollaborationToken } from '@/api/hooks';
import type {
  ChatMessage,
  OperationReceipt,
  ResourceEffect,
} from '@/api/types';
import { getLocale, m } from '@/i18n';
import { localUndoPayload } from '@/lib/localDb';
import { keepUndoPayloads, undoPayload } from '@/lib/undoPayloads';
import { ChatTrace, type UndoHandlers } from './ChatTrace';

// Each render records the buttons' props, and the test calls onClick; a
// mounted trace (linkedom, set before react-dom/client loads, the locale
// first) shows their labels.
const buttons = vi.hoisted(
  () => [] as { children?: unknown; onClick?: () => void }[]
);
vi.mock('@/components/ui/Button', async (original) => ({
  ...(await original<typeof import('@/components/ui/Button')>()),
  Button: (props: (typeof buttons)[number]) => {
    buttons.push(props);
    return <button type="button">{props.children as ReactNode}</button>;
  },
}));
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 20, 12, 0, s)).toISOString();

// One time for every payload of a test file: two calls across a second
// boundary would differ.
const issuedAt = Math.floor(Date.now() / 1000);

const payload = (operationId: string) => ({
  actorUserId: 'u_1',
  documentId: 'mat_1',
  epoch: 1,
  issuedAt,
  mac: 'f'.repeat(64),
  operationId,
  updates: { content: 'dW5kbw==' },
});

/** An edit's receipt in a finished turn. */
function trace(handlers: UndoHandlers, id: string, expiresAt?: string) {
  const edit: ResourceEffect = {
    operation: 'edited',
    operationId: id,
    resource: { id: 'mat_1', kind: 'material', title: 'Cells' },
    undo: { expiresAt, operationId: id, status: 'available' },
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
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ChatTrace handlers={handlers} live={false} mode="verbose" msg={msg} />
    </QueryClientProvider>
  );
}

/** The Undo button of an edit's receipt, if it shows one. */
function maybeUndoButton(
  handlers: UndoHandlers,
  id: string,
  expiresAt?: string
) {
  buttons.length = 0;
  renderToStaticMarkup(trace(handlers, id, expiresAt));
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

it('hides an Undo 24 h after its edit (Q385)', () => {
  keepUndoPayloads([payload('op_fresh'), payload('op_expired')]);
  const now = Date.now();
  const soon = new Date(now + 60_000).toISOString();
  const past = new Date(now - 1).toISOString();
  expect(maybeUndoButton(handlers(), 'op_fresh', soon)).toBeDefined();
  expect(maybeUndoButton(handlers(), 'op_expired', past)).toBeUndefined();
});

it('hides a mounted Undo when its 24 h end (Q385)', async () => {
  keepUndoPayloads([payload('op_mounted')]);
  vi.useFakeTimers();
  try {
    const end = new Date(Date.now() + 60_000).toISOString();
    const root = createRoot(document.getElementById('root') as never);
    await act(async () => root.render(trace(handlers(), 'op_mounted', end)));
    expect(document.body.textContent).toContain(m.chat_undo_edit());
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.body.textContent).not.toContain(m.chat_undo_edit());
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
  }
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

// Review r1 L7: only a refusal for good (`undo_unavailable`: a bad
// signature, another lineage, past its day, nothing left) drops the stored
// payload. Another (over quota here) hides the button for the session and
// keeps the payload, so the Undo can work once the account recovers.
it('drops the payload only when its Undo is refused for good', async () => {
  const refuse = (status: number, code: string) =>
    vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(
        new ApiError(status, 'Refused', undefined, { code })
      );
  // A click's own callbacks run only while its receipt is mounted.
  const refusedClick = async (id: string) => {
    const refused = handlers();
    buttons.length = 0;
    const root = createRoot(document.getElementById('root') as never);
    await act(async () => root.render(trace(refused, id)));
    const click = buttons.find(
      ({ children }) => children === m.chat_undo_edit()
    )?.onClick;
    await act(async () => click?.());
    await vi.waitFor(() => expect(refused.onUndoRefused).toHaveBeenCalled());
    await act(async () => root.unmount());
  };
  keepUndoPayloads([payload('op_quota'), payload('op_gone')]);
  refuse(403, 'quota_rejected');
  await refusedClick('op_quota');
  expect(await undoPayload('op_quota')).toBeDefined();
  refuse(409, 'undo_unavailable');
  await refusedClick('op_gone');
  expect(await undoPayload('op_gone')).toBeUndefined();
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
