import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applySavedSource, savedSourceUpdate } from './sourceState';

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A text room's saves: the first row whole, then the edits after it. */
function savedRows() {
  const room = new Y.Doc();
  const text = room.getText('source');
  text.insert(0, 'hello');
  const rows = [Y.encodeStateAsUpdate(room)];
  for (const edit of [' world', '!']) {
    const before = Y.encodeStateVector(room);
    text.insert(text.length, edit);
    rows.push(Y.encodeStateAsUpdate(room, before));
  }
  return rows.map(base64);
}

function textOf(update: Uint8Array | null) {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  return doc.getText('source').toString();
}

describe('savedSourceUpdate', () => {
  it('replays the rows saved over a state, or alone', () => {
    const [first, ...later] = savedRows();
    expect(
      textOf(savedSourceUpdate({ state: null, stateRows: [first, ...later] }))
    ).toBe('hello world!');
    expect(textOf(savedSourceUpdate({ state: first, stateRows: later }))).toBe(
      'hello world!'
    );
  });

  it('is null when nothing is saved', () => {
    expect(savedSourceUpdate({ state: null })).toBeNull();
  });
});

describe('applySavedSource', () => {
  it('applies the state and the rows in order, or reports nothing saved', () => {
    const [first, ...later] = savedRows();
    const doc = new Y.Doc();
    expect(applySavedSource(doc, { state: first, stateRows: later })).toBe(
      true
    );
    expect(doc.getText('source').toString()).toBe('hello world!');
    expect(applySavedSource(new Y.Doc(), { state: null })).toBe(false);
  });
});
