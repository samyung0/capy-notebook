import { useContext, useState } from 'react';
import type * as Y from 'yjs';
import { SimpleDialog } from '@/components/ui/Dialog';
import { UndoButtons } from '@/features/collaboration/LiveItemControls';
import {
  EditorSaveStatus,
  EditorStatusStoreContext,
} from '@/features/materials/CenterContentHeader';
import {
  MERMAID_TYPING_DELAY_MS,
  Mermaid,
  mermaidFailureMessage,
} from '@/features/materials/Mermaid';
import {
  editorHistory,
  MermaidCodeEditor,
} from '@/features/materials/MermaidCodeEditor';
import type { MermaidFailure } from '@/features/materials/mermaidError';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';
import { m } from '@/i18n';

/** The dialog's own typing: the note's Undo leaves it to the dialog's. */
const DIALOG_EDIT = Symbol('mermaid-dialog-edit');

/** Source on the left, a live preview in the block's theme on the right; the
 * line mermaid blames is marked in the source. Typing goes into the block's
 * source text as it happens (shape A, Epo 2026-10-10), merging with others'
 * typing; there is no Save or Cancel, the dialog closes with its X or Esc,
 * and its footer holds Undo, Redo and the note's save status. */
export default function MermaidSourceDialog({
  text,
  theme,
  onClose,
}: {
  text: Y.Text;
  theme: MermaidTheme;
  onClose: () => void;
}) {
  const [code, setCode] = useState(() => text.toString());
  // The preview keeps the last diagram that parsed; the error shows in the source.
  const [failure, setFailure] = useState<MermaidFailure | null>(null);
  const [history] = useState(editorHistory);
  const status = useContext(EditorStatusStoreContext);
  return (
    <SimpleDialog
      footer={
        <div className="mr-auto flex items-center gap-2">
          <UndoButtons manager={history.target} />
          {status && <EditorSaveStatus layout="office" store={status} />}
        </div>
      }
      onClose={onClose}
      open
      title={m.editor_diagram()}
      width={880}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <MermaidCodeEditor
            className="h-72 rounded-card border border-line bg-field"
            errorLine={failure?.line ?? null}
            label={m.editor_mermaid_source()}
            onChange={setCode}
            onView={history.attach}
            origin={DIALOG_EDIT}
            text={text}
            value={code}
          />
          {/* A blamed line is marked in the source instead. */}
          {failure && failure.line == null && (
            <p className="mt-1 font-semibold text-solid-error text-xs">
              {mermaidFailureMessage(failure)}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <Mermaid
            code={code}
            delay={MERMAID_TYPING_DELAY_MS}
            onError={setFailure}
            theme={theme}
          />
        </div>
      </div>
    </SimpleDialog>
  );
}
