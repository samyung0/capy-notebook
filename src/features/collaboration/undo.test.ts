import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { limitUndo, UNDO_HORIZON_MS } from './undo';

const HOUR = 60 * 60 * 1000;

// In-place collection (Epo 2026-10-23): Undo reaches back 24 h by the tab's
// own clock, since the server keeps what an Undo restores for 25 h.
it('drops Undo and Redo steps older than 24 h before undoing', () => {
  let clock = 0;
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const manager = new Y.UndoManager(text, { captureTimeout: 0 });
  limitUndo(manager, () => clock);
  limitUndo(manager, () => clock);
  text.insert(0, 'a');
  clock = 2 * HOUR;
  text.insert(1, 'b');
  clock = 2 * HOUR + 1;
  text.insert(2, 'c');
  // 'c' undone now: its Redo step is as old as the Undo.
  manager.undo();
  expect(text.toString()).toBe('ab');
  // 24 h after 'a' was typed, its step is gone; 'b' still undoes.
  clock = UNDO_HORIZON_MS + 1;
  manager.undo();
  expect(text.toString()).toBe('a');
  expect(manager.undoStack).toHaveLength(0);
  manager.redo();
  expect(text.toString()).toBe('ab');
  // Past 24 h from the Undo of 'c', its Redo is gone too.
  clock = 2 * HOUR + 2 + UNDO_HORIZON_MS;
  manager.redo();
  expect(text.toString()).toBe('ab');
  expect(manager.redoStack).toHaveLength(0);
});
