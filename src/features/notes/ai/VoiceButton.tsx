import { Mic } from 'lucide-react';
import { useEditorRef } from 'platejs/react';
import { useCallback } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useVoiceInput } from './useVoiceInput';

/** Mic toggle that dictates into the note at the cursor. Records while active, then save as audio file */
export function VoiceButton() {
  const editor = useEditorRef();
  const insert = useCallback(
    (text: string) => {
      editor.tf.focus();
      editor.tf.insertText(text.trim() + ' ');
    },
    [editor]
  );
  const { recording, busy, toggle } = useVoiceInput(insert);

  if (busy) {
    return (
      <ButtonTooltip label={m.editor_saving_audio()}>
        <span className="inline-flex size-8 items-center justify-center">
          <Spinner />
        </span>
      </ButtonTooltip>
    );
  }
  return (
    <ToolbarButton
      active={recording}
      className={cn('p-0', recording && 'animate-pulse bg-tint-accent-1/70')}
      label={recording ? m.editor_stop_recording() : m.editor_dictate()}
      onClick={toggle}
    >
      <Mic />
    </ToolbarButton>
  );
}
