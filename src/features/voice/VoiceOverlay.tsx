import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import {
  useVoiceInput,
  VoiceElapsed,
} from '@/features/workspace/chat/VoiceInput';
import { insertTranscript } from '@/features/workspace/chat/voiceRecording';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import './voice.css';

/** Phones and tablets: focusing the box would raise the keyboard over the
 * dialog, although the user came to speak. */
const touch = () => !matchMedia('(pointer: fine)').matches;

/**
 * Voice input over the whole page: the page dims and blurs, and one box
 * holds the transcript to edit or type into. Recording starts when it opens;
 * Send starts a new chat with the text (`onSend`), where the answer shows.
 * Enter adds a line, as the box is large and phones' keyboards always do;
 * only the button sends.
 */
export function VoiceOverlay({
  open,
  onOpenChange,
  workspaceId,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace whose chat this starts; null for the account chat. */
  workspaceId: string | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Counts closings: a transcript from an earlier opening, still under way
  // when the dialog closed, never lands in a later one.
  const opening = useRef(0);
  const mine = opening.current;
  // Like the composer: at the caret, over a selection, spaced except beside
  // Chinese or Japanese.
  const onText = (heard: string) => {
    const field = fieldRef.current;
    if (opening.current !== mine || !field) return;
    const { selectionStart: start, selectionEnd: end, value } = field;
    const inserted = insertTranscript(value, heard, start, end);
    flushSync(() => setText(inserted.value));
    if (!touch()) field.focus({ preventScroll: true });
    field.setSelectionRange(inserted.caret, inserted.caret);
  };
  const { phase, toggle, elapsedMs, error } = useVoiceInput(
    workspaceId,
    onText,
    open
  );

  // Opening clears the box and starts a recording, once a clip from an
  // earlier opening has finished transcribing; closing drops the recording
  // (useVoiceInput).
  const wantsRecording = useRef(false);
  useEffect(() => {
    if (!open) return;
    setText('');
    wantsRecording.current = true;
    return () => {
      opening.current += 1;
      wantsRecording.current = false;
    };
  }, [open]);
  useEffect(() => {
    if (!(open && phase === 'idle' && wantsRecording.current)) return;
    wantsRecording.current = false;
    toggle();
  });

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'pending';
  const trimmed = text.trim();
  const length = textLength(text);
  // Sending mid-recording would drop what is being said.
  const sendable =
    !!trimmed && length <= CHAT_CHARACTER_LIMIT && !busy && !recording;
  const send = () => {
    if (!sendable) return;
    onSend(trimmed);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="voice-scrim fixed inset-0 z-50 bg-page/35 backdrop-blur-md dark:bg-black/30" />
        {/* Centred by its margins, not a transform, which its entry
            animation owns, in the space above a phone's keyboard; a press
            anywhere outside it closes it. */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="voice-card fixed inset-x-0 top-0 bottom-[var(--keyboard-inset,0px)] z-50 m-auto flex h-fit w-[calc(100%-2rem)] max-w-140 flex-col gap-1 rounded-card-xl border border-white/50 bg-white/55 p-3 shadow-pop outline-none backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-[rgb(24_24_36/0.55)]"
          onOpenAutoFocus={(event) => {
            // Touch screens keep the dialog itself focused (Radix would
            // focus Close), so no keyboard comes up.
            event.preventDefault();
            if (touch()) (event.currentTarget as HTMLElement).focus();
            else fieldRef.current?.focus();
          }}
        >
          <div className="flex items-center justify-between gap-2 pl-1.5">
            <DialogPrimitive.Title className="t-card-title font-bold">
              {m.chat_new()}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton
                icon="x"
                label={m.action_close()}
                size="sm"
                variant="ghost-hover"
              />
            </DialogPrimitive.Close>
          </div>
          <div className="relative">
            {/* Grows with the text up to about half the screen, then
                  scrolls without a scrollbar. */}
            <Textarea
              aria-invalid={length > CHAT_CHARACTER_LIMIT || undefined}
              aria-label={m.voice_overlay_field()}
              className={cn(
                'max-h-[min(50dvh,calc(14lh+--spacing(4)))] min-h-36 resize-none rounded-none border-0 bg-transparent px-1.5 py-2 text-[1.05rem] text-fg leading-relaxed [scrollbar-width:none] focus:border-0 [&::-webkit-scrollbar]:hidden'
              )}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                recording
                  ? m.voice_overlay_listening()
                  : m.voice_overlay_placeholder()
              }
              ref={fieldRef}
              value={text}
            />
          </div>
          {error && (
            <p className="t-meta px-1.5 text-tint-error-fg" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2 border-divider border-t pt-2.5">
            <button
              aria-label={
                phase === 'pending'
                  ? m.voice_transcribing()
                  : recording
                    ? m.voice_stop()
                    : m.voice_record()
              }
              aria-pressed={recording}
              className={cn(
                'relative flex size-10 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-100',
                recording
                  ? 'voice-flow text-white'
                  : 'border border-line text-fg hover:bg-surface-hover-bg'
              )}
              disabled={busy}
              onClick={toggle}
              type="button"
            >
              {busy ? (
                <Spinner className="size-4" />
              ) : recording ? (
                <span className="size-3 rounded-[3px] bg-current" />
              ) : (
                <Icon name="microphone" size={18} />
              )}
            </button>
            {recording && (
              // The dot sits a pixel high against the time's x-height.
              <VoiceElapsed
                className="ml-1.5 [&>span:first-child]:-translate-y-px"
                elapsedMs={elapsedMs}
              />
            )}
            {phase === 'pending' && (
              <span className="t-meta ml-1.5 text-fg-muted">
                {m.voice_transcribing()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <CharCount max={CHAT_CHARACTER_LIMIT} value={length} />
              <Button
                disabled={!sendable}
                iconRight="send"
                onClick={send}
                size="md"
                variant="dark"
              >
                {m.voice_overlay_send()}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
