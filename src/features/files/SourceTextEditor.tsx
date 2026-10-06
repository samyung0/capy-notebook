import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { m } from '@/i18n';
import {
  applyTextEdit,
  applyTextInput,
  beginTextComposition,
  displayText,
  displayTextOffset,
  type InputStart,
  inputStart,
  SOURCE_TEXT_INPUT,
  sourceLines,
  sourceTextOffset,
  textareaEdit,
} from './sourceTextBinding';

export function SourceTextEditor({
  doc,
  paused,
  onSave,
  registerFlush,
  onPendingChange,
}: {
  doc: Y.Doc;
  paused: boolean;
  onSave: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  registerFlush: { current: (() => Promise<void>) | null };
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const text = doc.getText('source');
    const undo = new Y.UndoManager(text, {
      trackedOrigins: new Set([SOURCE_TEXT_INPUT]),
    });
    let composition: {
      commit: (composed: string) => void;
      start: number;
    } | null = null;
    // A peer edited while composing: the textarea catches up at the end.
    let missed = false;
    // The textarea when the input being handled began (beforeinput).
    let started: InputStart | null = null;
    const waiting: (() => void)[] = [];
    let selection: {
      start: Y.RelativePosition;
      end: Y.RelativePosition;
      direction: 'forward' | 'backward' | 'none';
    } | null = null;
    const raw = text.toString();
    let lines = sourceLines(raw);
    input.value = raw;
    const toSource = (offset: number) =>
      lines.cr ? sourceTextOffset(text.toString(), offset) : offset;
    const before = (transaction: Y.Transaction) => {
      if (composition || transaction.origin === SOURCE_TEXT_INPUT) return;
      selection = {
        direction: input.selectionDirection,
        end: Y.createRelativePositionFromTypeIndex(
          text,
          toSource(input.selectionEnd)
        ),
        start: Y.createRelativePositionFromTypeIndex(
          text,
          toSource(input.selectionStart)
        ),
      };
    };
    const render = () => {
      if (composition) {
        missed = true;
        return;
      }
      const value = text.toString();
      lines = sourceLines(value);
      input.value = value;
      if (selection) {
        const start = Y.createAbsolutePositionFromRelativePosition(
            selection.start,
            doc
          ),
          end = Y.createAbsolutePositionFromRelativePosition(
            selection.end,
            doc
          );
        const toDisplay = (offset: number) =>
          lines.cr ? displayTextOffset(value, offset) : offset;
        if (start && end)
          input.setSelectionRange(
            toDisplay(start.index),
            toDisplay(end.index),
            selection.direction
          );
      }
    };
    const observe = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin !== SOURCE_TEXT_INPUT) render();
    };
    const beforeInput = (event: InputEvent) => {
      started = composition ? null : inputStart(event, input);
    };
    // Typing, paste, Enter and deletions apply in O(edit); anything else
    // the whole value's difference does.
    const change = (event: Event) => {
      const begun = started;
      started = null;
      if (composition) return;
      const edit =
        begun &&
        event instanceof InputEvent &&
        textareaEdit(event, begun, input);
      if (edit) applyTextEdit(text, edit, lines);
      else applyTextInput(text, input.value, lines);
    };
    const compositionStart = () => {
      undo.stopCapturing();
      missed = false;
      composition = {
        ...beginTextComposition(
          text,
          input.selectionStart,
          input.selectionEnd,
          lines
        ),
        start: input.selectionStart,
      };
      onPendingChange?.(true);
    };
    const compositionEnd = (event?: CompositionEvent) => {
      const active = composition;
      if (!active) return;
      composition = null;
      const composed =
        event?.data ?? input.value.slice(active.start, input.selectionEnd);
      // The IME committed at the caret: only the composed text goes in. An
      // IME that rewrote other text leaves it to the whole value's
      // difference.
      if (input.selectionStart === active.start + displayText(composed).length)
        active.commit(composed);
      else applyTextInput(text, input.value, lines);
      onPendingChange?.(false);
      if (missed) render();
      undo.stopCapturing();
      for (const resolve of waiting.splice(0)) resolve();
    };
    registerFlush.current = () =>
      composition
        ? new Promise<void>((resolve) => waiting.push(resolve))
        : Promise.resolve();
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void registerFlush
          .current?.()
          .then(() => onSaveRef.current())
          .catch(() => {});
      }
      if (!composition && (key === 'z' || key === 'y')) {
        event.preventDefault();
        if (event.shiftKey || key === 'y') undo.redo();
        else undo.undo();
      }
    };
    input.addEventListener('beforeinput', beforeInput);
    input.addEventListener('input', change);
    input.addEventListener('compositionstart', compositionStart);
    input.addEventListener('compositionend', compositionEnd);
    input.addEventListener('keydown', key);
    doc.on('beforeTransaction', before);
    text.observe(observe);
    return () => {
      // Commit authored IME operations before detaching the binding.
      compositionEnd();
      registerFlush.current = null;
      input.removeEventListener('beforeinput', beforeInput);
      input.removeEventListener('input', change);
      input.removeEventListener('compositionstart', compositionStart);
      input.removeEventListener('compositionend', compositionEnd);
      input.removeEventListener('keydown', key);
      doc.off('beforeTransaction', before);
      text.unobserve(observe);
      undo.destroy();
    };
  }, [doc, registerFlush, onPendingChange]);
  return (
    <textarea
      aria-label={m.source_edit_raw()}
      className="h-full min-h-[50vh] w-full resize-none bg-surface p-4 font-mono text-sm leading-relaxed outline-none"
      readOnly={paused}
      ref={textarea}
      spellCheck={false}
    />
  );
}
