import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { boardFirstState } from './boardFirstState';

/** The bytes the collaboration server seeds a canvas room with
 * (`Model::Board`, `include_bytes!`). */
const FIXTURE = new URL(
  '../../../collaboration-rs/crates/server/fixtures/board-first-state.bin',
  import.meta.url
);

// `WRITE_BOARD_FIRST_STATE=1` rewrites the fixture from the editor's own store.
it('makes the first state the collaboration server seeds', () => {
  const state = boardFirstState();
  if (process.env.WRITE_BOARD_FIRST_STATE === '1') {
    mkdirSync(new URL('.', FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, state);
  }
  const fixture = readFileSync(FIXTURE);
  expect(Buffer.from(state).equals(fixture)).toBe(true);
  // A second call in the same tab writes the same bytes.
  expect(Buffer.from(boardFirstState()).equals(fixture)).toBe(true);
});

it('holds a page and its canvas, written under client 1', () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState());
  expect([...doc.share.keys()]).toEqual(['blocks']);
  expect([...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()]).toEqual([
    1,
  ]);
  expect(doc.getMap('blocks').toJSON()).toEqual({
    page: {
      'prop:title': '',
      'sys:children': ['surface'],
      'sys:flavour': 'affine:page',
    },
    surface: {
      'prop:elements': { type: '$blocksuite:internal:native$', value: {} },
      'sys:children': [],
      'sys:flavour': 'affine:surface',
    },
  });
});
