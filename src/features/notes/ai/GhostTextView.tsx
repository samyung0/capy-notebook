import { CopilotPlugin } from '@platejs/ai/react';
import { useEditorRef, useElement, usePluginOption } from 'platejs/react';
import { useEffect } from 'react';
import { useMe } from '@/api/hooks';
import { setGhostTextState } from './ghostText';

/** Under every block; subscribes only to whether this block holds the
 * suggestion, so a changing suggestion re-renders one block, not the note. */
export function GhostText() {
  const element = useElement();
  const isSuggested = usePluginOption(
    CopilotPlugin,
    'isSuggested',
    element.id as string
  );
  return isSuggested ? <SuggestionText /> : null;
}

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
