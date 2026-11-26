import { CopilotPlugin } from '@platejs/ai/react';
import type { TElement } from 'platejs';
import {
  type PlateEditor,
  useEditorPluginOption,
  useEditorRef,
  usePluginOption,
} from 'platejs/react';
import { type ReactNode, useEffect } from 'react';
import { useMe } from '@/api/hooks';
import { setGhostTextState } from './ghostText';

/** Under every block; subscribes only to whether this block holds the
 * suggestion, so a changing suggestion re-renders one block, not the note.
 * Reads through the editor and element it is given: `useElement` and
 * `usePluginOption` would subscribe every block to the editor's and the
 * element's stores as well. */
function GhostText({
  editor,
  element,
}: {
  editor: PlateEditor;
  element: TElement;
}) {
  const isSuggested = useEditorPluginOption(
    editor,
    CopilotPlugin,
    'isSuggested',
    element.id as string
  );
  return isSuggested ? <SuggestionText /> : null;
}

/** CopilotPlugin's `belowNodes`, as Plate's (each element's children, then its
 * ghost text), with the element's editor and element passed down. */
export const ghostTextBelowNodes =
  ({ editor, element }: { editor: PlateEditor; element: TElement }) =>
  ({ children }: { children: ReactNode }) => (
    <>
      {children}
      <GhostText editor={editor} element={element} />
    </>
  );

function SuggestionText() {
  const suggestionText = usePluginOption(CopilotPlugin, 'suggestionText');
  if (!suggestionText) return null;
  return (
    <span
      className="pointer-events-auto hidden text-fg-muted/70 sm:inline"
      contentEditable={false}
    >
      {suggestionText}
    </span>
  );
}

/** Hands the user's note AI switch and the note title to the ghost text
 * plugin; turning the switch off also drops a suggestion on screen. */
export function GhostTextSync({ title }: { title: string }) {
  const editor = useEditorRef();
  const { data: me } = useMe();
  const enabled = me?.noteAiEnabled === true;
  useEffect(() => {
    const copilot = editor.getApi(CopilotPlugin).copilot;
    setGhostTextState(editor, { enabled, title });
    if (!enabled) {
      copilot.stop();
      copilot.reject();
    }
    return () => {
      setGhostTextState(editor, { enabled: false, title });
      copilot.stop();
    };
  }, [editor, enabled, title]);
  return null;
}
