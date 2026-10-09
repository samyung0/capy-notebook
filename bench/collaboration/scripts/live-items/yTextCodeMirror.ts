/* Prototype (live-items DESIGN.md 6): CodeMirror 6 bound to a Y.Text without
 * y-codemirror.next. Local changes go into the Y.Text under `origin`; remote
 * ones come back as one CodeMirror transaction kept out of the undo history,
 * so CodeMirror's own history() is each user's Undo of their own typing. */
import {
  Annotation,
  type ChangeSet,
  type ChangeSpec,
  type Extension,
  Transaction,
} from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type * as Y from 'yjs';

const fromYjs = Annotation.define<boolean>();

/** A Y.Text event's delta as CodeMirror changes (positions in the old doc). */
export function deltaChanges(delta: Y.YTextEvent['delta']): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let at = 0;
  for (const op of delta) {
    if (op.insert != null) changes.push({ from: at, insert: op.insert as string });
    else if (op.delete != null) {
      changes.push({ from: at, to: at + op.delete });
      at += op.delete;
    } else at += op.retain ?? 0;
  }
  return changes;
}

/** A CodeMirror change set applied to the Y.Text it was made against. */
export function applyChanges(text: Y.Text, changes: ChangeSet, origin: unknown) {
  text.doc?.transact(() => {
    let shift = 0;
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) text.delete(fromA + shift, toA - fromA);
      if (inserted.length) text.insert(fromA + shift, inserted.toString());
      shift += inserted.length - (toA - fromA);
    });
  }, origin);
}

export function yTextSync(text: Y.Text, origin: unknown): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        text.observe(this.observe);
      }
      private readonly observe = (event: Y.YTextEvent, tr: Y.Transaction) => {
        if (tr.origin === origin) return;
        this.view.dispatch({
          annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)],
          changes: deltaChanges(event.delta),
        });
      };
      update(update: ViewUpdate) {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromYjs)))
          applyChanges(text, update.changes, origin);
      }
      destroy() {
        text.unobserve(this.observe);
      }
    }
  );
}
