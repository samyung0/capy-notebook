import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ActivityBlock, ChatMessage, ResourceEffect } from '@/api/types';
import { ChatTrace } from './ChatTrace';

// An Office edit the engine cut at a per-call limit (Epo 2026-10-23, Q171).
const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();

const edit = (id: string): ResourceEffect => ({
  operation: 'edited',
  operationId: id,
  resource: { id: 'f_1', kind: 'source_file', title: 'grades.xlsx' },
  undo: { operationId: id, status: 'available' },
});

function cut(more: Partial<Extract<ActivityBlock, { kind: 'tool' }>>) {
  return {
    callId: 'c1',
    detail: 'grades.xlsx',
    id: 'c1',
    kind: 'tool',
    name: 'edit_office_document',
    startedAt: at(1),
    ...more,
  } as const;
}

function render(activity: ActivityBlock[], live: boolean) {
  const msg: ChatMessage = {
    activity,
    content: live ? '' : 'Done.',
    createdAt: at(0),
    id: 'm1',
    phase: live ? 'running_tools' : undefined,
    role: 'assistant',
    status: live ? 'streaming' : 'complete',
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTrace
        handlers={{ onUndoApplied: () => {}, onUndoRefused: () => {} }}
        live={live}
        mode="verbose"
        msg={msg}
      />
    </QueryClientProvider>
  );
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

it('shows a cut edit in progress with how many commands applied', () => {
  const html = text(render([cut({ applied: 30, total: 32 })], true));
  expect(html).toContain('Editing grades.xlsx');
  expect(html).toContain('30 of 32');
  expect(html).not.toContain('Undo');
});

it('closes it after the follow-up as a receipt like any edit', () => {
  const closed = cut({ effects: [edit('op_1')], endedAt: at(2) });
  const html = text(
    render(
      [
        { ...closed, outcome: 'succeeded' },
        {
          ...closed,
          callId: 'c2',
          effects: [edit('op_2')],
          id: 'c2',
          outcome: 'succeeded',
        },
      ],
      false
    )
  );
  expect(html.match(/Edited grades\.xlsx/g)).toHaveLength(2);
  expect(html.match(/Undo/g)).toHaveLength(2);
  expect(html).not.toContain('of 32');
  expect(html).not.toContain('not applied');
});

it('ends showing the commands a turn left unapplied', () => {
  const html = text(
    render(
      [
        cut({
          applied: 30,
          effects: [edit('op_1')],
          endedAt: at(2),
          outcome: 'succeeded',
          total: 32,
        }),
      ],
      false
    )
  );
  expect(html).toContain('Edited grades.xlsx');
  expect(html).toContain('2 commands not applied');
  expect(html).toContain('Undo');
});
