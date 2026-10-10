import {
  Annotation,
  type ChangeSet,
  type ChangeSpec,
  type Extension,
  Transaction,
} from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type * as Y from 'yjs';

/* CodeMirror bound to a Y.Text (a Mermaid source, shape A; live-items
 * DESIGN.md 6.4), without y-codemirror.next: local changes go into the text
 * under `origin`, remote ones come back as one CodeMirror transaction kept out
 * of its undo history, so CodeMirror's history() undoes this user's own
 * typing. Offsets are UTF-16 units on both sides. */

const fromYjs = Annotation.define<boolean>();

/** A Y.Text event's delta as CodeMirror changes (positions in the old doc). */
export function deltaChanges(delta: Y.YTextEvent['delta']): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let at = 0;
  for (const op of delta) {
    if (typeof op.insert === 'string')
      changes.push({ from: at, insert: op.insert });
    else if (op.delete == null) at += op.retain ?? 0;
    else {
      changes.push({ from: at, to: at + op.delete });
      at += op.delete;
    }
  }
  return changes;
}

/** A CodeMirror change set applied to the text it was made against. */
export function applyChanges(
  text: Y.Text,
  changes: ChangeSet,
  origin: unknown
) {
  const apply = () => {
    let shift = 0;
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) text.delete(fromA + shift, toA - fromA);
      if (inserted.length) text.insert(fromA + shift, inserted.toString());
      shift += inserted.length - (toA - fromA);
    });
  };
  if (text.doc) text.doc.transact(apply, origin);
  else apply();
}

/** Keeps the editor and `text` equal; the editor must start from its string. */
export function yTextSync(text: Y.Text, origin: unknown): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        text.observe(this.observe);
      }
      private readonly observe = (
        event: Y.YTextEvent,
        transaction: Y.Transaction
      ) => {
        if (transaction.origin === origin) return;
        this.view.dispatch({
          annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)],
          changes: deltaChanges(event.delta),
        });
      };
      update(update: ViewUpdate) {
        if (
          update.docChanged &&
          !update.transactions.some((tr) => tr.annotation(fromYjs))
        )
          applyChanges(text, update.changes, origin);
      }
      destroy() {
        text.unobserve(this.observe);
      }
    }
  );
}
