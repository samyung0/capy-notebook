import {
  history,
  historyKeymap,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import {
  EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import type { UndoTarget } from '@/features/collaboration/undo';
import { cn } from '@/lib/cn';
import { yTextSync } from './yTextCodeMirror';

/* Only state, view and history load here (78 KB gzipped with this file's
 * imports, measured 2026-10-09); the default keymap would pull in the
 * language package for 13 KB more. Typing, Enter, Backspace and arrows are
 * the browser's own editing, which CodeMirror reads back. */

const setErrorLine = StateEffect.define<number | null>();

const errorLine = StateField.define<number | null>({
  create: () => null,
  update: (line, transaction) => {
    for (const effect of transaction.effects)
      if (effect.is(setErrorLine)) return effect.value;
    return line;
  },
});

const errorGutter = new (class extends GutterMarker {
  override elementClass = 'cm-error-gutter';
})();

/** The blamed line tinted and underlined, its number in red. Lines past the
 * end (the source shrank before the next render) mark nothing. */
const errorMarks = [
  EditorView.decorations.compute([errorLine, 'doc'], (state) => {
    const line = state.field(errorLine);
    if (line == null || line > state.doc.lines) return Decoration.none;
    return Decoration.set(
      Decoration.line({ class: 'cm-error-line' }).range(
        state.doc.line(line).from
      )
    );
  }),
  gutterLineClass.compute([errorLine, 'doc'], (state) => {
    const line = state.field(errorLine);
    if (line == null || line > state.doc.lines) return RangeSet.empty;
    return RangeSet.of([errorGutter.range(state.doc.line(line).from)]);
  }),
];

const theme = EditorView.theme({
  '.cm-content': { caretColor: 'var(--color-fg)', padding: '14px 0' },
  // The browser's own selection: CodeMirror's drawn one sits under line
  // backgrounds, so it vanished on the marked line.
  '.cm-content ::selection': {
    backgroundColor:
      'color-mix(in srgb, var(--action-accent-bg) 35%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-fg)' },
  '.cm-error-gutter': { color: 'var(--solid-error)', fontWeight: '700' },
  '.cm-error-line': {
    backgroundColor: 'var(--tint-error-bg)',
    textDecoration: 'underline wavy var(--solid-error) 1px',
    textUnderlineOffset: '4px',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
  },
  '.cm-line': { padding: '0 16px 0 0' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '44px',
    padding: '0 14px 0 0',
  },
  // Ligatures would draw `-->` as one arrow, hiding what is typed.
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
    lineHeight: '22px',
  },
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-fg)',
    fontSize: '13px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
});

/** Tab indents by two spaces; Shift+Tab is left to move focus out. */
const indentKey = {
  key: 'Tab',
  run: (view: EditorView) => {
    view.dispatch(view.state.replaceSelection('  '), {
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  },
};

/** Refuses a typed, pasted or undone change that takes the source past
 * `maxBytes` of UTF-8 and grows it (`onRefused` hears of it); remote edits
 * carry no user event and always land. */
export function byteBound(maxBytes: number, onRefused: () => void): Extension {
  // Up to 3 bytes a UTF-16 unit: a short source needs no count.
  const bytes = (doc: Text) =>
    doc.length * 3 <= maxBytes
      ? 0
      : new TextEncoder().encode(doc.toString()).length;
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(Transaction.userEvent) === undefined)
      return tr;
    const next = bytes(tr.newDoc);
    if (next <= maxBytes || next <= bytes(tr.startState.doc)) return tr;
    onRefused();
    return [];
  });
}

/** Undo and Redo keys that act on a live item's history instead of the
 * editor's own (the standalone diagram's header buttons share it). */
function itemHistoryKeys(target: UndoTarget): Extension {
  const act = (step: () => void) => () => {
    step();
    return true;
  };
  return keymap.of([
    { key: 'Mod-z', preventDefault: true, run: act(() => target.undo()) },
    { key: 'Mod-y', preventDefault: true, run: act(() => target.redo()) },
    {
      key: 'Mod-Shift-z',
      preventDefault: true,
      run: act(() => target.redo()),
    },
  ]);
}

/** The editor's own history as Undo and Redo buttons read it (a note's
 * Mermaid dialog, whose typing the note's Undo does not cover). */
export function editorHistory(): {
  attach: (view: EditorView | null) => void;
  target: UndoTarget;
} {
  let view: EditorView | null = null;
  const listeners = new Set<() => void>();
  return {
    attach: (next) => {
      view = next;
      for (const notify of listeners) notify();
    },
    target: {
      canRedo: () => !!view && redoDepth(view.state) > 0,
      canUndo: () => !!view && undoDepth(view.state) > 0,
      redo: () => view && redo(view),
      subscribe: (notify) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      undo: () => view && undo(view),
    },
  };
}

/**
 * Mermaid source with line numbers, undo and the blamed line marked.
 * Bound to a live source (`text`), it edits that Y.Text under `origin` and
 * follows others' edits; otherwise the parent owns the string and a `value`
 * that differs from what is typed replaces the document. `history` hands
 * Undo and Redo to a live item's history; without it the editor keeps its
 * own, which `onView` lets the caller drive. `maxBytes` refuses edits past
 * that many bytes (`byteBound`).
 */
export function MermaidCodeEditor({
  className,
  errorLine: line,
  history: itemHistory,
  label,
  maxBytes,
  onChange,
  onRefused,
  onView,
  origin,
  text,
  value,
}: {
  className?: string;
  errorLine: number | null;
  history?: UndoTarget;
  label: string;
  maxBytes?: number;
  onChange: (value: string) => void;
  onRefused?: () => void;
  onView?: (view: EditorView | null) => void;
  origin?: unknown;
  text?: Y.Text;
  value: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  // Created once per bound text; the effects below keep it in step with
  // the other props.
  useEffect(() => {
    const created = new EditorView({
      doc: text ? text.toString() : value,
      extensions: [
        lineNumbers(),
        itemHistory
          ? [keymap.of([indentKey]), itemHistoryKeys(itemHistory)]
          : [history(), keymap.of([indentKey, ...historyKeymap])],
        text ? yTextSync(text, origin) : [],
        maxBytes ? byteBound(maxBytes, () => onRefusedRef.current?.()) : [],
        errorLine,
        errorMarks,
        theme,
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            onChangeRef.current(update.state.doc.toString());
          if (update.transactions.length) onViewRef.current?.(update.view);
        }),
      ],
      parent: host.current!,
    });
    view.current = created;
    onViewRef.current?.(created);
    if (text) onChangeRef.current(created.state.doc.toString());
    return () => {
      created.destroy();
      view.current = null;
      onViewRef.current?.(null);
    };
  }, [text]);

  useEffect(() => {
    const current = view.current;
    if (text || !current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, insert: value, to: current.state.doc.length },
    });
  }, [value, text]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(line) });
  }, [line]);

  return <div className={cn('min-h-0', className)} ref={host} />;
}
