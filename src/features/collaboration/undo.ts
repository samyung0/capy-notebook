import type * as Y from 'yjs';

/** What Undo and Redo act on: one live item document's own edits, or a
 * quiz's two documents together. */
export interface UndoTarget {
  canRedo(): boolean;
  canUndo(): boolean;
  redo(): void;
  subscribe(notify: () => void): () => void;
  undo(): void;
}

const EVENTS = [
  'stack-item-added',
  'stack-item-popped',
  'stack-cleared',
] as const;

function listen(manager: Y.UndoManager, notify: () => void) {
  for (const event of EVENTS) manager.on(event, notify);
  return () => {
    for (const event of EVENTS) manager.off(event, notify);
  };
}

/** How far back editors' Undo reaches, by the tab's own clock (in-place
 * collection, Epo 2026-10-23): the server keeps the deletions an Undo may
 * restore for 25 h after they arrived. */
export const UNDO_HORIZON_MS = 24 * 60 * 60 * 1000;

const limited = new WeakSet<Y.UndoManager>();

/**
 * Keeps `manager`'s Undo and Redo within UNDO_HORIZON_MS: each stack item
 * records when it was made (`time`), and steps older than the horizon are
 * dropped before every Undo and Redo, whoever calls it (the note editor's
 * history, an item room's buttons, a shortcut). Once per manager.
 */
export function limitUndo(manager: Y.UndoManager, now = () => Date.now()) {
  if (limited.has(manager)) return;
  limited.add(manager);
  manager.on('stack-item-added', ({ stackItem }) => {
    if (!stackItem.meta.has('time')) stackItem.meta.set('time', now());
  });
  const drop = () => {
    const oldest = now() - UNDO_HORIZON_MS;
    for (const stack of [manager.undoStack, manager.redoStack]) {
      const kept = stack.findIndex(
        (item) => ((item.meta.get('time') as number | undefined) ?? 0) >= oldest
      );
      stack.splice(0, kept === -1 ? stack.length : kept);
    }
  };
  const { redo, undo } = manager;
  manager.undo = () => {
    drop();
    return undo.call(manager);
  };
  manager.redo = () => {
    drop();
    return redo.call(manager);
  };
}

export function undoTarget(manager: Y.UndoManager): UndoTarget {
  return {
    canRedo: () => manager.redoStack.length > 0,
    canUndo: () => manager.undoStack.length > 0,
    redo: () => manager.redo(),
    subscribe: (notify) => listen(manager, notify),
    undo: () => manager.undo(),
  };
}

/** Steps of the two documents this close together are one user step (an
 * answer type change writes both). */
const SAME_STEP_MS = 100;

/**
 * Undo across a quiz's content and keys documents (live-items DESIGN.md 5):
 * each stack item records when it was made, Undo reverts the latest step of
 * either document, and steps of both made together undo (and redo) as one.
 */
export function pairedUndo(
  first: Y.UndoManager,
  second: Y.UndoManager
): UndoTarget {
  for (const manager of [first, second])
    manager.on('stack-item-added', ({ stackItem }) => {
      stackItem.meta.set('time', Date.now());
    });
  const time = (stack: Y.UndoManager['undoStack']) =>
    (stack.at(-1)?.meta.get('time') as number | undefined) ?? null;
  const step = (
    stack: 'undoStack' | 'redoStack',
    act: (manager: Y.UndoManager) => void
  ) => {
    const a = time(first[stack]);
    const b = time(second[stack]);
    if (a === null && b === null) return;
    if (a !== null && b !== null && Math.abs(a - b) <= SAME_STEP_MS) {
      act(first);
      act(second);
      return;
    }
    act(b === null || (a !== null && a > b) ? first : second);
  };
  return {
    canRedo: () => first.redoStack.length + second.redoStack.length > 0,
    canUndo: () => first.undoStack.length + second.undoStack.length > 0,
    redo: () => step('redoStack', (manager) => manager.redo()),
    subscribe: (notify) => {
      const stopFirst = listen(first, notify);
      const stopSecond = listen(second, notify);
      return () => {
        stopFirst();
        stopSecond();
      };
    },
    undo: () => step('undoStack', (manager) => manager.undo()),
  };
}
