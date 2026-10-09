import { history, historyKeymap } from '@codemirror/commands';
import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

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
    fontVariantNumeric: 'tabular-nums',
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
const indentKeys = keymap.of([
  {
    key: 'Tab',
    run: (view) => {
      view.dispatch(view.state.replaceSelection('  '), {
        scrollIntoView: true,
        userEvent: 'input',
      });
      return true;
    },
  },
  ...historyKeymap,
]);

/**
 * Mermaid source with line numbers, undo and the blamed line marked. The
 * parent owns the text: a `value` that differs from what is typed (Cancel, a
 * remote change) replaces the document.
 */
export function MermaidCodeEditor({
  className,
  errorLine: line,
  label,
  onChange,
  value,
}: {
  className?: string;
  errorLine: number | null;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Created once; the effects below keep it in step with the props.
  useEffect(() => {
    const created = new EditorView({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        indentKeys,
        errorLine,
        errorMarks,
        theme,
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            onChangeRef.current(update.state.doc.toString());
        }),
      ],
      parent: host.current!,
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, insert: value, to: current.state.doc.length },
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(line) });
  }, [line]);

  return <div className={cn('min-h-0', className)} ref={host} />;
}
