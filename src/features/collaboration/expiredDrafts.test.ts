import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { draftFile } from './expiredDrafts';

// A canvas's old edits download as its blocks, never an empty card list.
it("downloads a board's expired edits as its blocks in JSON", () => {
  const doc = new Y.Doc();
  const block = new Y.Map<unknown>();
  doc.getMap('blocks').set('surface', block);
  block.set('sys:flavour', 'affine:surface');
  const { extension, text } = draftFile(doc, undefined);
  expect(extension).toBe('json');
  expect(JSON.parse(text)).toEqual({
    surface: { 'sys:flavour': 'affine:surface' },
  });
});
