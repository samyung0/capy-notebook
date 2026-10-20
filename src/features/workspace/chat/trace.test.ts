import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import type { ActivityBlock, ResourceEffect } from '@/api/types';
import {
  buildTrace,
  foldSegments,
  foldTrace,
  latestStep,
  stepTitle,
  type ToolBlock,
  toolIcon,
  undoAction,
  undoRefused,
} from './trace';

const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 15, 12, 0, s)).toISOString();

function tool(
  id: string,
  name: string,
  times?: [number, number],
  more: Partial<ToolBlock> = {}
): ToolBlock {
  return {
    callId: id,
    id,
    kind: 'tool',
    name,
    outcome: 'succeeded',
    ...(times ? { endedAt: at(times[1]), startedAt: at(times[0]) } : {}),
    ...more,
  };
}

const quiz: ResourceEffect = {
  operation: 'created',
  resource: { id: 'qz_1', kind: 'material', materialKind: 'quiz', title: 'Q' },
  undo: { operationId: 'op_1', status: 'available' },
};

const base = { live: false, startedAt: at(0), stopped: false, thinking: false };

describe('toolIcon', () => {
  it('acts out each tool family and bounces for the rest', () => {
    expect(toolIcon('search_knowledge')).toBe('search');
    expect(toolIcon('read_skill')).toBe('read');
    expect(toolIcon('capture_page')).toBe('look');
    expect(toolIcon('list_trashed_files')).toBe('list');
    expect(toolIcon('write_slide')).toBe('edit');
    expect(toolIcon('inspect_office_document')).toBe('read');
    expect(toolIcon('edit_office_document')).toBe('edit');
    expect(toolIcon('trash_file')).toBe('trash');
    expect(toolIcon('restore_file')).toBe('restore');
    expect(toolIcon('read_study_progress')).toBe('bouncy');
    expect(toolIcon('a_future_tool')).toBe('bouncy');
  });
});

describe('stepTitle', () => {
  const read = tool('r', 'read_document', undefined, {
    detail: 'Cell transport.pdf',
  });
  it('is present tense while running and past tense when done', () => {
    expect(stepTitle(read, 'running').text).toBe('Reading Cell transport.pdf');
    expect(stepTitle(read, 'done').text).toBe('Read Cell transport.pdf');
    expect(stepTitle(read, 'failed').text).toBe(
      "Couldn't read Cell transport.pdf"
    );
    expect(stepTitle(read, 'stopped').text).toBe(
      'Stopped while reading Cell transport.pdf'
    );
  });
  it('words the Office tools as the document tools', () => {
    const file = { detail: 'grades.xlsx' };
    expect(
      stepTitle(tool('i', 'inspect_office_document', undefined, file), 'done')
        .text
    ).toBe('Inspected grades.xlsx');
    expect(
      stepTitle(tool('e', 'edit_office_document', undefined, file), 'running')
        .text
    ).toBe('Editing grades.xlsx');
  });
  it('titles an Office create as create_material titles its file', () => {
    const created = tool('e', 'edit_office_document', undefined, {
      detail: 'Grades.xlsx',
      effects: [
        {
          operation: 'created',
          resource: { id: 'f_1', kind: 'source_file', title: 'Grades.xlsx' },
        },
      ],
    });
    expect(stepTitle(created, 'done').text).toBe('Created Grades.xlsx');
  });
  it('quotes a search query and labels a capture by its page', () => {
    const search = tool('s', 'search_workspace', undefined, {
      detail: 'osmosis',
    });
    expect(stepTitle(search, 'done')).toEqual({
      label: '“osmosis”',
      text: 'Searched your sources for “osmosis”',
    });
    const look = tool('c', 'capture_page', undefined, {
      capture: { bbox: null, bytes: 1, page: 12 },
    });
    expect(stepTitle(look, 'running').text).toBe('Looking at page 12');
  });
});

describe('buildTrace', () => {
  it('adds thinking for gaps between steps and groups one tool in a row', () => {
    const rows = buildTrace({
      ...base,
      activity: [
        tool('a', 'search_workspace', [3, 4]),
        tool('b', 'search_workspace', [4, 5]),
        tool('c', 'read_document', [7, 8]),
      ],
    });
    expect(rows.map((row) => row.type)).toEqual([
      'thinking',
      'group',
      'thinking',
      'step',
    ]);
    expect(rows[0]).toMatchObject({ seconds: 3 });
    expect(rows[1]).toMatchObject({ name: 'search_workspace' });
  });

  it('says only Thought before the first step without timestamps', () => {
    const rows = buildTrace({
      ...base,
      activity: [tool('a', 'list_sources'), tool('b', 'read_document')],
      startedAt: undefined,
    });
    expect(rows.map((row) => row.type)).toEqual(['thinking', 'step', 'step']);
    expect(rows[0]).not.toHaveProperty('seconds');
  });

  it('runs only the newest open tool and stops the rest when aborted', () => {
    const activity: ActivityBlock[] = [
      tool('a', 'read_document', undefined, { outcome: undefined }),
      tool('b', 'read_document', undefined, { outcome: undefined }),
    ];
    const live = buildTrace({ ...base, activity, live: true });
    const states = live.map((row) => (row.type === 'step' ? row.state : null));
    expect(states.filter(Boolean)).toEqual(['unknown', 'running']);
    const stopped = buildTrace({ ...base, activity, stopped: true });
    expect(stopped.at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('folds later steps on a created file into its card and keeps edit receipts, Undo or not', () => {
    const edit: ResourceEffect = {
      operation: 'edited',
      resource: { id: 'f_2', kind: 'source_file', title: 'Notes.md' },
      undo: { operationId: 'op_2', status: 'available' },
    };
    const rows = buildTrace({
      ...base,
      activity: [
        tool('a', 'create_material', [1, 2], { effects: [quiz] }),
        tool('b', 'add_questions', [2, 3], {
          effects: [{ ...quiz, operation: 'edited', undo: undefined }],
        }),
        tool('c', 'edit_document', [3, 4], { effects: [edit] }),
        // An edit no loaded room took has no Undo; its receipt still shows.
        tool('d', 'edit_document', [4, 5], {
          effects: [{ ...edit, undo: undefined }],
        }),
      ],
    });
    expect(rows.map((row) => row.type)).toEqual([
      'thinking',
      'created',
      'edited',
      'edited',
    ]);
  });
});

it('shows a quiz that add_questions started as a created card, also once trashed', () => {
  for (const operation of ['created', 'trashed'] as const) {
    const rows = buildTrace({
      ...base,
      activity: [
        tool('a', 'add_questions', [1, 2], {
          effects: [{ ...quiz, operation }],
        }),
      ],
    });
    expect(rows.at(-1)).toMatchObject({ type: 'created' });
  }
});

describe('Normal mode', () => {
  const activity = [
    tool('a', 'search_workspace', [2, 3]),
    tool('b', 'create_material', [5, 9], { effects: [quiz] }),
  ];
  it('folds every step behind one row and keeps the receipts', () => {
    const fold = foldTrace({ ...base, activity });
    expect(fold.steps).toBe(4);
    expect(fold.rows.map((row) => row.type)).toEqual([
      'thinking',
      'step',
      'thinking',
      'step',
    ]);
    expect(fold.receipts.map((row) => row.type)).toEqual(['created']);
  });
  it('titles the fold with the latest step', () => {
    const fold = foldTrace({
      ...base,
      activity: [tool('a', 'list_sources'), tool('b', 'search_workspace')],
      startedAt: undefined,
    });
    expect(latestStep(fold.rows)).toEqual({
      icon: 'search',
      index: fold.rows.length - 1,
      text: stepTitle(tool('b', 'search_workspace'), 'done').text,
    });
  });
  it('folds only the steps between narrations', () => {
    const fold = foldTrace({
      ...base,
      activity: [
        tool('a', 'list_sources'),
        { id: 'n', kind: 'narration', text: 'Checking the textbook.' },
        tool('b', 'search_knowledge'),
      ],
      startedAt: undefined,
    });
    expect(
      foldSegments(fold.rows).map((rows) => rows.map((row) => row.type))
    ).toEqual([['thinking', 'step'], ['narration'], ['step']]);
  });
});

it('offers Undo until a step is undone, then Redo', () => {
  expect(undoAction('created')).toBe('undo');
  expect(undoAction('edited')).toBe('undo');
  expect(undoAction('restored')).toBe('undo');
  expect(undoAction('edit_undone')).toBe('redo');
  expect(undoAction('trashed')).toBe('redo');
});

it('keeps Undo after an unknown outcome and hides it after a refusal', () => {
  expect(undoRefused(new ApiError(409, 'Conflict'))).toBe(true);
  expect(undoRefused(new ApiError(503, 'Service Unavailable'))).toBe(false);
  expect(undoRefused(new TypeError('Failed to fetch'))).toBe(false);
});
