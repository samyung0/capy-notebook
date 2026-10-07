import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { savedSourceUpdate, textSeed } from './sourceState';

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A room over the text seed that saved two rows (delta saves). */
function savedRows(base: Uint8Array) {
  const room = new Y.Doc();
  Y.applyUpdate(room, textSeed(base));
  const rows: Uint8Array[] = [];
  for (const edit of [' world', '!']) {
    const before = Y.encodeStateVector(room);
    const text = room.getText('source');
    text.insert(text.length, edit);
    rows.push(Y.encodeStateAsUpdate(room, before));
  }
  return { room, rows: rows.map(base64) };
}

function textOf(update: Uint8Array | null) {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  return doc.getText('source').toString();
}

describe('savedSourceUpdate', () => {
  const base = new TextEncoder().encode('hello');

  it('replays rows over a text seed it rebuilds from the base', () => {
    const { rows } = savedRows(base);
    const update = savedSourceUpdate(
      { format: 'text', state: null, stateRows: rows },
      base
    );
    expect(textOf(update)).toBe('hello world!');
  });

  it('replays rows over a stored state, and nothing saved is null', () => {
    const { room, rows } = savedRows(base);
    const state = base64(Y.encodeStateAsUpdate(room));
    expect(
      textOf(savedSourceUpdate({ format: 'text', state, stateRows: rows }))
    ).toBe('hello world!');
    expect(savedSourceUpdate({ format: 'docx', state: null })).toBeNull();
  });
});
