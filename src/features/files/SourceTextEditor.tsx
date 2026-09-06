import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { m } from '@/i18n';
import {
  applyTextInput,
  beginTextComposition,
  displayTextOffset,
  SOURCE_TEXT_INPUT,
  sourceTextOffset,
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
    let composition: ReturnType<typeof beginTextComposition> | null = null;
    const waiting: (() => void)[] = [];
    let selection: {
      start: Y.RelativePosition;
      end: Y.RelativePosition;
      direction: 'forward' | 'backward' | 'none';
    } | null = null;
    input.value = text.toString();
    const before = (transaction: Y.Transaction) => {
      if (composition || transaction.origin === SOURCE_TEXT_INPUT) return;
      selection = {
        direction: input.selectionDirection,
        end: Y.createRelativePositionFromTypeIndex(
          text,
          sourceTextOffset(text.toString(), input.selectionEnd)
        ),
        start: Y.createRelativePositionFromTypeIndex(
          text,
          sourceTextOffset(text.toString(), input.selectionStart)
        ),
      };
    };
    const render = () => {
      if (composition) return;
      input.value = text.toString();
      if (selection) {
        const start = Y.createAbsolutePositionFromRelativePosition(
            selection.start,
            doc
          ),
          end = Y.createAbsolutePositionFromRelativePosition(
            selection.end,
            doc
          );
        if (start && end)
          input.setSelectionRange(
            displayTextOffset(text.toString(), start.index),
            displayTextOffset(text.toString(), end.index),
            selection.direction
          );
      }
    };
    const observe = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin !== SOURCE_TEXT_INPUT) render();
    };
    const change = () => applyTextInput(composition?.text ?? text, input.value);
    const compositionStart = () => {
      undo.stopCapturing();
      composition = beginTextComposition(doc);
      onPendingChange?.(true);
    };
    const compositionEnd = () => {
      if (!composition) return;
      applyTextInput(composition.text, input.value);
      selection = {
        direction: input.selectionDirection,
        end: Y.createRelativePositionFromTypeIndex(
          composition.text,
          sourceTextOffset(composition.text.toString(), input.selectionEnd)
        ),
        start: Y.createRelativePositionFromTypeIndex(
          composition.text,
          sourceTextOffset(composition.text.toString(), input.selectionStart)
        ),
      };
      composition.commit();
      composition.destroy();
      composition = null;
      onPendingChange?.(false);
      render();
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
