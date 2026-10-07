import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import { m } from '@/i18n';
import { bindSourceTextarea } from './sourceTextBinding';

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
    return bindSourceTextarea(input, doc, {
      onPendingChange,
      onSave: () => onSaveRef.current(),
      registerFlush,
    });
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
