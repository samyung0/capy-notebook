import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type {
  ChatMessage,
  OperationReceipt,
  ResourceEffect,
} from '@/api/types';
import { m } from '@/i18n';
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

function renderUndo(handlers: UndoHandlers, id: string, expiresAt?: string) {
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
  buttons.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTrace handlers={handlers} live={false} mode="verbose" msg={msg} />
    </QueryClientProvider>
  );
  return buttons.find(({ children }) => children === m.chat_undo_edit());
}

function undoButton(handlers: UndoHandlers, id: string) {
  const button = renderUndo(handlers, id);
  if (!button?.onClick) throw new Error('no Undo button');
  return button.onClick;
}

const handlers = () => ({
  onUndoApplied: vi.fn(),
  onUndoRefused: vi.fn(),
});

it('hides an Undo 24 h after its edit (Q385)', () => {
  const now = Date.now();
  const soon = new Date(now + 60_000).toISOString();
  const past = new Date(now - 1).toISOString();
  expect(renderUndo(handlers(), 'op_fresh', soon)).toBeDefined();
  expect(renderUndo(handlers(), 'op_expired', past)).toBeUndefined();
});

it('sends one Undo for two clicks while the first is out', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockReturnValue(new Promise<OperationReceipt>(() => {}));
  const click = undoButton(handlers(), 'op_two_clicks');
  click();
  click();
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(post).toHaveBeenCalledOnce();
});
