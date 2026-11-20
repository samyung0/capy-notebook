import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { seedCards } from '@/features/flashcards/liveSet';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import {
  keysScope,
  readQuestions,
  seedQuiz,
} from '@/features/quizzes/liveQuiz';
import type { DeletedDrafts, EditDraft } from '@/lib/editDrafts';
import { canSaveDeletedEdits, saveDeletedEdits } from './deletedEditsFile';

// The stored rows by document, and what was saved: no server is asked.
const stored = vi.hoisted(() => ({
  bases: new Map<string, Uint8Array>(),
  rows: new Map<string, EditDraft[]>(),
  saved: [] as { blob: Blob; name: string }[],
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  readDraftBase: async (key: string, base: string) =>
    stored.bases.get(`${key}@${base}`),
  readDrafts: async (key: string) => stored.rows.get(key) ?? [],
}));
vi.mock('@/features/notes/documentAdapters', () => ({
  downloadEditorFile: (blob: Blob, name: string) =>
    stored.saved.push({ blob, name }),
}));
// The export worker's Markdown, run in this process.
vi.mock('@/features/notes/export/client', async (load) => {
  const { exportLabels } =
    await load<typeof import('@/features/notes/export/client')>();
  const { renderExport } = await import('@/features/notes/export/render');
  return {
    runExportWorker: async ({
      noteUrl,
      value,
    }: {
      noteUrl: string;
      value: Parameters<typeof renderExport>[0];
    }) => {
      const { content } = await renderExport(
        value,
        'markdown',
        exportLabels(),
        {},
        noteUrl,
        () => Promise.reject(new Error('no figures here'))
      );
      return { blob: new Blob([content]), extension: 'md' };
    },
  };
});
const exported = vi.hoisted(() => vi.fn());
vi.mock('@/office-runtime/exportCheckpoint', () => ({
  exportCheckpoint: exported,
}));
// This device's copy of a content room, by material id.
const copies = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/features/collaboration/deviceCopy', async () => {
  const Yjs = await import('yjs');
  return {
    readRoomSeed: async (_owner: string, id: string) => {
      const state = copies.get(id);
      if (!state) return null;
      const doc = new Yjs.Doc();
      Yjs.applyUpdate(doc, state);
      return { doc };
    },
  };
});

vi.stubGlobal('location', new URL('https://capy.test/'));

/** Every row stored now offered, as the sweep does. */
const offering = (drafts: Omit<DeletedDrafts, 'offered'>): DeletedDrafts => ({
  ...drafts,
  offered: Object.fromEntries(
    drafts.keys.map((key) => [
      key,
      (stored.rows.get(key) ?? []).map((row) => row.id),
    ])
  ),
});

/** The toast's Download. */
const save = (drafts: Omit<DeletedDrafts, 'offered'>) =>
  saveDeletedEdits(offering(drafts));

beforeEach(() => {
  stored.rows.clear();
  stored.bases.clear();
  stored.saved.length = 0;
  copies.clear();
});

/** A closed session's whole document, as its recorder left it. */
function stateRow(key: string, doc: Y.Doc, base?: string): EditDraft {
  return {
    base,
    data: Y.encodeStateAsUpdate(doc),
    id: 's:state',
    key,
    kind: 'state',
    lineage: 'material:x:schema:1',
    savedAt: Date.now(),
    seq: 1,
    session: 's',
  };
}

async function saved() {
  const [file] = stored.saved;
  return { name: file.name, text: await file.blob.text() };
}

it('saves a note as Markdown, with what the server holds as lines saying it is not included', async () => {
  const doc = new Y.Doc();
  doc.get('content', Y.XmlText).applyDelta(
    slateNodesToInsertDelta([
      { children: [{ text: 'Mitosis splits a nucleus.' }], type: 'p' },
      { assetId: 'a1', children: [{ text: '' }], type: 'img' },
      {
        children: [{ text: '' }],
        materialId: 'q1',
        refKind: 'quiz',
        type: 'material_ref',
      },
    ] as never),
    { sanitize: false }
  );
  stored.rows.set('u:material:n', [stateRow('u:material:n', doc)]);
  await save({
    file: false,
    id: 'n',
    item: { kind: 'note', name: 'Cell notes' },
    keys: ['u:material:n'],
  });
  const { name, text } = await saved();
  expect(name).toBe('Cell notes (unsaved edits).md');
  expect(text).toContain('Mitosis splits a nucleus.');
  expect(text).toContain('Image not included');
  expect(text).toContain('Quiz not included');
});

it("saves a quiz's questions with its keys' edits as JSON", async () => {
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, exampleQuestions);
  stored.rows.set('u:material:q', [stateRow('u:material:q', content)]);
  stored.rows.set('u:material:q:keys', [stateRow('u:material:q:keys', keys)]);
  await save({
    file: false,
    id: 'q',
    item: { kind: 'quiz', name: 'Cell quiz' },
    keys: ['u:material:q:keys', 'u:material:q'],
  });
  const { name, text } = await saved();
  expect(name).toBe('Cell quiz (unsaved edits).json');
  expect(JSON.parse(text)).toEqual(
    JSON.parse(JSON.stringify(readQuestions(content, keys)))
  );
});

it('saves a set as tab-separated cards and a diagram as its source', async () => {
  const set = new Y.Doc();
  seedCards(set, [{ back: 'Two cells', front: 'Mitosis', id: 'c1' }]);
  stored.rows.set('u:material:f', [stateRow('u:material:f', set)]);
  const diagram = new Y.Doc();
  diagram.get('content', Y.XmlText).applyDelta(
    slateNodesToInsertDelta([
      {
        children: [{ children: [{ text: '' }], type: 'mermaid_caption' }],
        id: 'b',
        source: 'graph TD; A --> B',
        type: 'mermaid',
      },
    ] as never),
    { sanitize: false }
  );
  stored.rows.set('u:material:d', [stateRow('u:material:d', diagram)]);
  await save({
    file: false,
    id: 'f',
    item: { kind: 'flashcards', name: 'Cards' },
    keys: ['u:material:f'],
  });
  await save({
    file: false,
    id: 'd',
    item: { kind: 'diagram', name: 'Flow' },
    keys: ['u:material:d'],
  });
  const [cards, flow] = stored.saved;
  expect(cards.name).toBe('Cards (unsaved edits).tsv');
  expect(await cards.blob.text()).toBe('Mitosis\tTwo cells');
  expect(flow.name).toBe('Flow (unsaved edits).mmd');
  expect(await flow.blob.text()).toBe('graph TD; A --> B');
});

it('saves a text file as its source under its own extension', async () => {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, '# Plan');
  stored.rows.set('u:file:t', [stateRow('u:file:t', doc)]);
  await save({
    file: true,
    id: 't',
    item: { kind: 'md', name: 'plan.md' },
    keys: ['u:file:t'],
  });
  expect(await saved()).toEqual({
    name: 'plan (unsaved edits).md',
    text: '# Plan',
  });
});

it('exports an Office file from its stored base and the whole document its drafts draw', async () => {
  const doc = new Y.Doc();
  doc.getMap('body').set('text', 'Edited');
  stored.rows.set('u:file:o', [stateRow('u:file:o', doc, 'sha')]);
  stored.bases.set('u:file:o@sha', new Uint8Array([1, 2, 3]));
  exported.mockResolvedValueOnce(new Uint8Array([9]));
  await save({
    file: true,
    id: 'o',
    item: { kind: 'doc', name: 'report.docx' },
    keys: ['u:file:o'],
  });
  const [format, base, state, seed] = exported.mock.calls[0];
  expect(format).toBe('docx');
  expect(new Uint8Array(base)).toEqual(new Uint8Array([1, 2, 3]));
  const drawn = new Y.Doc();
  Y.applyUpdate(drawn, new Uint8Array(state));
  expect(drawn.getMap('body').get('text')).toBe('Edited');
  expect(seed).toBeUndefined();
  const { name } = await saved();
  expect(name).toBe('report (unsaved edits).docx');
});

// A note's saved copy (edits made before its room joined, Q229) newer than
// what its Yjs rows draw is what the file holds, and the one row its
// Download then deletes (review 2026-11-20): the older rows stay for the
// next page load's offer.
it("saves a note's newer saved copy, and draws only its row", async () => {
  const doc = new Y.Doc();
  doc
    .get('content', Y.XmlText)
    .applyDelta(
      slateNodesToInsertDelta([
        { children: [{ text: 'An older edit.' }], type: 'p' },
      ] as never),
      { sanitize: false }
    );
  const copy: EditDraft = {
    data: new TextEncoder().encode(
      JSON.stringify({
        mine: [{ children: [{ text: 'Typed in the copy.' }], type: 'p' }],
      })
    ),
    id: 's:copy',
    key: 'u:material:n',
    kind: 'copy',
    lineage: 'material:x:schema:1',
    savedAt: Date.now() + 1000,
    seq: 1,
    session: 's',
  };
  stored.rows.set('u:material:n', [stateRow('u:material:n', doc), copy]);
  const drew = await save({
    file: false,
    id: 'n',
    item: { kind: 'note', name: 'Cell notes' },
    keys: ['u:material:n'],
  });
  const { text } = await saved();
  expect(text).toContain('Typed in the copy.');
  expect(text).not.toContain('An older edit.');
  expect(drew.get('u:material:n')).toEqual({ rows: [copy] });
});

// A quiz whose only unsent edits are to its keys (review 2026-11-20): the
// sweep names its keys document alone, and its questions come from this
// device's copy of its content room, which the copy sweep keeps meanwhile.
it("saves a quiz's key edits with its questions from this device's copy", async () => {
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, exampleQuestions);
  copies.set('q', Y.encodeStateAsUpdate(content));
  stored.rows.set('u:material:q:keys', [stateRow('u:material:q:keys', keys)]);
  const drew = await save({
    file: false,
    id: 'q',
    item: { kind: 'quiz', name: 'Cell quiz' },
    keys: ['u:material:q:keys'],
  });
  const { text } = await saved();
  expect(JSON.parse(text)).toEqual(
    JSON.parse(JSON.stringify(readQuestions(content, keys)))
  );
  expect([...drew.keys()]).toEqual(['u:material:q:keys']);
});

// With no copy, the file says its questions are not included: it never reads
// as the whole quiz.
it("saves a quiz's key edits under a line saying its questions are missing", async () => {
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, exampleQuestions);
  stored.rows.set('u:material:q:keys', [stateRow('u:material:q:keys', keys)]);
  await save({
    file: false,
    id: 'q',
    item: { kind: 'quiz', name: 'Cell quiz' },
    keys: ['u:material:q:keys'],
  });
  const { text } = await saved();
  expect(JSON.parse(text)).toEqual({
    about: 'Questions not included. Only your answer key edits are here.',
    answerKeys: keysScope(keys).toJSON(),
  });
});

// Review 2026-11-20 (4): edits that make no file get Discard alone, so the
// toast asks first: update rows whose state is gone, or an Office file whose
// base is no longer stored.
it('tells drafts that make a file from ones that cannot', async () => {
  const doc = new Y.Doc();
  doc.getMap('body').set('text', 'Edited');
  stored.rows.set('u:file:o', [stateRow('u:file:o', doc, 'sha')]);
  const office = offering({
    file: true,
    id: 'o',
    item: { kind: 'doc', name: 'report.docx' },
    keys: ['u:file:o'],
  });
  expect(await canSaveDeletedEdits(office)).toBe(false);
  stored.bases.set('u:file:o@sha', new Uint8Array([1, 2, 3]));
  expect(await canSaveDeletedEdits(office)).toBe(true);

  const room = new Y.Doc();
  room.getMap('cards').set('a', 'Room card');
  const typed = new Y.Doc();
  Y.applyUpdate(typed, Y.encodeStateAsUpdate(room));
  const before = Y.encodeStateVector(typed);
  typed.getMap('cards').delete('a');
  stored.rows.set('u:material:set', [
    {
      ...stateRow('u:material:set', typed),
      data: Y.encodeStateAsUpdate(typed, before),
      id: 's:1',
      kind: 'update',
    },
  ]);
  expect(
    await canSaveDeletedEdits(
      offering({
        file: false,
        id: 'set',
        item: { kind: 'flashcards', name: 'Cells' },
        keys: ['u:material:set'],
      })
    )
  ).toBe(false);
});

// Review 2026-11-20 (5): a set's, a diagram's or a mind map's file holds what
// its drawing holds; an empty one makes no file.
it('makes no file of a set whose drawing holds no cards', async () => {
  const set = (cards: Parameters<typeof seedCards>[1]) => {
    const doc = new Y.Doc();
    if (cards.length) seedCards(doc, cards);
    stored.rows.set('u:material:f', [stateRow('u:material:f', doc)]);
    return offering({
      file: false,
      id: 'f',
      item: { kind: 'flashcards', name: 'Cards' },
      keys: ['u:material:f'],
    });
  };
  expect(await canSaveDeletedEdits(set([]))).toBe(false);
  expect(
    await canSaveDeletedEdits(
      set([{ back: 'Two cells', front: 'Mitosis', id: 'c1' }])
    )
  ).toBe(true);
});
