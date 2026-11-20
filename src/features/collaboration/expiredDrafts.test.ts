import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { draftFile } from './expiredDrafts';

// A canvas's old edits download as its blocks, never an empty card list.
it("downloads a board's expired edits as its blocks in JSON", () => {
  const doc = new Y.Doc();
  const block = new Y.Map<unknown>();
  doc.getMap('blocks').set('surface', block);
  block.set('sys:flavour', 'affine:surface');
  expect(draftFile(doc, 'canvas', undefined)).toEqual({
    extension: 'json',
    text: JSON.stringify(
      { surface: { 'sys:flavour': 'affine:surface' } },
      null,
      2
    ),
  });
});

// Drafts that hold nothing to save make no empty file (review 2026-11-20).
it('makes no file of drafts that hold nothing', () => {
  expect(draftFile(new Y.Doc(), 'diagram', undefined)).toBeNull();
});
