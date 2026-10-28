import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/TextArea';
import {
  useVoiceInput,
  VoiceElapsed,
} from '@/features/workspace/chat/VoiceInput';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import './voice.css';

const CHAT_INPUT_MAX = 4000;
/** How long each revealed word waits after the one before, in ms. */
const WORD_STAGGER_MS = 40;
const SPACES = /\s+/;

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
  const [reveal, setReveal] = useState<string[] | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const onText = (heard: string) => {
    const words = heard.split(SPACES).filter(Boolean);
    setText((before) => (before.trim() ? `${before.trim()} ${heard}` : heard));
    setReveal(words);
    setTimeout(
      () => {
        setReveal(null);
        fieldRef.current?.focus();
      },
      words.length * WORD_STAGGER_MS + 420
    );
  };
  const { phase, toggle, elapsedMs, error } = useVoiceInput(
    workspaceId,
    onText,
    open
  );

  // Opening starts a recording; closing drops it (useVoiceInput) and the text.
  const toggleOnOpen = useRef(toggle);
  toggleOnOpen.current = toggle;
  useEffect(() => {
    if (!open) return;
    setText('');
    setReveal(null);
    toggleOnOpen.current();
  }, [open]);

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'pending';
  const trimmed = text.trim();
  const send = () => {
    if (!trimmed || trimmed.length > CHAT_INPUT_MAX || busy) return;
    onSend(trimmed);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="voice-scrim fixed inset-0 z-50 bg-page/35 backdrop-blur-md dark:bg-black/30" />
        {/* Centred by its margins, not a transform, which its entry
            animation owns; a press anywhere outside it closes it. */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="voice-card fixed inset-0 z-50 m-auto flex h-fit w-[calc(100%-2rem)] max-w-140 flex-col gap-1 rounded-card-xl border border-white/50 bg-white/55 p-3 shadow-pop outline-none backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-[rgb(24_24_36/0.55)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            fieldRef.current?.focus();
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
              aria-label={m.voice_overlay_field()}
              className={cn(
                'max-h-[min(50dvh,calc(14lh+--spacing(4)))] min-h-36 resize-none rounded-none border-0 bg-transparent px-1.5 py-2 text-[1.05rem] text-fg leading-relaxed [scrollbar-width:none] focus:border-0 [&::-webkit-scrollbar]:hidden',
                reveal && 'text-transparent'
              )}
              maxLength={CHAT_INPUT_MAX}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                recording
                  ? m.voice_overlay_listening()
                  : m.voice_overlay_placeholder()
              }
              ref={fieldRef}
              value={text}
            />
            {reveal && (
              <p
                aria-hidden
                className="pointer-events-none absolute inset-0 px-1.5 py-2 text-[1.05rem] text-fg leading-relaxed"
              >
                {reveal.map((word, index) => (
                  <span
                    className="voice-word"
                    key={index}
                    style={{ animationDelay: `${index * WORD_STAGGER_MS}ms` }}
                  >
                    {word}{' '}
                  </span>
                ))}
              </p>
            )}
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
            <Button
              className="ml-auto"
              disabled={!trimmed || busy}
              iconRight="send"
              onClick={send}
              size="md"
              variant="dark"
            >
              {m.voice_overlay_send()}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
