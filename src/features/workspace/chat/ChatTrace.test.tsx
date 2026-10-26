import 'fake-indexeddb/auto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ActivityBlock, ChatMessage, ResourceEffect } from '@/api/types';
import { m } from '@/i18n';
import { keepUndoPayloads } from '@/lib/undoPayloads';
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

// An edit shows its Undo while the browser holds its payload (Epo
// 2026-10-21).
keepUndoPayloads(
  ['op_1', 'op_2'].map((operationId) => ({
    documentId: 'f_1',
    epoch: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    mac: 'f'.repeat(64),
    operationId,
    updates: { source: 'dW5kbw==' },
  }))
);

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

it('ends with a warning icon whose tooltip names the commands left', () => {
  const markup = render(
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
  );
  const html = text(markup);
  expect(html).toContain('Edited grades.xlsx');
  expect(html).toContain('Undo');
  // The warning is the icon's label and tooltip, not inline text.
  expect(html).not.toContain('not applied');
  expect(markup).toContain('aria-label="2 commands not applied"');
  // Once undone, nothing of the edit stands.
  const undone = render(
    [
      cut({
        applied: 30,
        effects: [{ ...edit('op_1'), operation: 'edit_undone' }],
        endedAt: at(2),
        outcome: 'succeeded',
        total: 32,
      }),
    ],
    false
  );
  expect(text(undone)).toContain('Undid the edit to grades.xlsx');
  expect(undone).not.toContain('not applied');
});

// Q268, Q300: a turn waiting for the limiter or an AI slot reads only
// "Waiting" in the trace, the same for both.
it('shows a waiting turn in the trace', () => {
  for (const phase of ['waiting_limit', 'waiting_capacity'] as const) {
    const msg: ChatMessage = {
      content: '',
      createdAt: at(0),
      id: 'm1',
      phase,
      role: 'assistant',
      status: 'streaming',
    };
    for (const mode of ['verbose', 'normal'] as const) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ChatTrace
            handlers={{ onUndoApplied: () => {}, onUndoRefused: () => {} }}
            live
            mode={mode}
            msg={msg}
          />
        </QueryClientProvider>
      );
      expect(text(html).trim()).toBe(m.chat_trace_waiting());
    }
  }
});
