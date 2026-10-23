import { useEffect, useRef, useState } from 'react';
import { useTranscribeVoice } from '@/api/hooks';
import { Spinner } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { formatClock } from '@/features/files/citationRegions';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  micErrorMessage,
  type Recording,
  recordingType,
  startRecording,
  VOICE_MAX_MS,
  voiceErrorMessage,
} from './voiceRecording';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'pending';

export interface VoiceInput {
  elapsedMs: number;
  /** The last failure, shown under the composer until the next recording. */
  error: string | null;
  phase: VoicePhase;
  /** False where the browser cannot record: the button is not shown. */
  supported: boolean;
  toggle: () => void;
}

/**
 * The composer's voice input: a recording toggled by one button, stopped at
 * the two-minute limit, then transcribed; `onText` gets the transcript. A
 * recording is dropped, and the microphone released, when the composer is
 * hidden (`shown` false) or goes; a transcription under way still lands.
 */
export function useVoiceInput(
  workspaceId: string,
  onText: (text: string) => void,
  shown: boolean
): VoiceInput {
  const [mimeType] = useState(recordingType);
  const { mutate, isPending, error, reset } = useTranscribeVoice(workspaceId);
  const [phase, setPhase] = useState<Exclude<VoicePhase, 'pending'>>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  const live = useRef(false);

  useEffect(() => {
    if (!shown) return;
    live.current = true;
    return () => {
      live.current = false;
      recording.current?.cancel();
      recording.current = null;
      setPhase('idle');
    };
  }, [shown]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [phase]);

  async function start(type: string) {
    reset();
    setMicError(null);
    setPhase('starting');
    try {
      const next = await startRecording(type, (clip) => {
        recording.current = null;
        setPhase('idle');
        mutate(clip, { onSuccess: ({ text }) => onText(text) });
      });
      // The composer went while the browser asked for the microphone.
      if (!live.current) {
        next.cancel();
        setPhase('idle');
        return;
      }
      recording.current = next;
      const at = Date.now();
      setStartedAt(at);
      setNow(at);
      setPhase('recording');
    } catch (failure) {
      setPhase('idle');
      setMicError(micErrorMessage(failure));
    }
  }

  return {
    elapsedMs: Math.min(Math.max(now - startedAt, 0), VOICE_MAX_MS),
    error: micError ?? (error ? voiceErrorMessage(error) : null),
    phase: isPending ? 'pending' : phase,
    supported: mimeType !== null,
    toggle: () => {
      if (phase === 'recording') recording.current?.stop();
      else if (phase === 'idle' && !isPending && mimeType) void start(mimeType);
    },
  };
}

/** The bordered mic button, with the elapsed time and the limit while it
 * records and a spinner while the clip is transcribed. */
export function VoiceButton({
  phase,
  elapsedMs,
  onToggle,
}: Pick<VoiceInput, 'phase' | 'elapsedMs'> & { onToggle: () => void }) {
  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'pending';
  const elapsed = m.voice_elapsed({
    elapsed: formatClock(elapsedMs),
    limit: formatClock(VOICE_MAX_MS),
  });
  return (
    <>
      {recording && (
        <span
          className="t-meta flex items-center gap-1.5 whitespace-nowrap text-fg-muted"
          data-voice-elapsed
        >
          <span
            aria-hidden
            className="size-2 rounded-full bg-solid-error motion-safe:animate-pulse"
          />
          {elapsed}
        </span>
      )}
      <IconButton
        aria-pressed={recording}
        // 9px keeps the bordered button as tall as Send beside it.
        className={cn(
          'rounded-full p-[9px]',
          recording && 'border-solid-error text-tint-error-fg'
        )}
        disabled={busy}
        icon={recording ? 'stop' : 'microphone'}
        iconClassName={cn(busy && 'invisible', recording && 'fill-current')}
        label={
          phase === 'pending'
            ? m.voice_transcribing()
            : recording
              ? m.voice_stop()
              : m.voice_record()
        }
        onClick={onToggle}
        size="sm"
        tooltip
        variant="outline"
      >
        {busy && <Spinner className="absolute size-4" />}
      </IconButton>
    </>
  );
}
