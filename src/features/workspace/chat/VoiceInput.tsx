import { type MouseEventHandler, useEffect, useRef, useState } from 'react';
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
  /** The microphone's signal while recording, for VoiceWaveform. */
  analyser: AnalyserNode | null;
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
  workspaceId: string | null,
  onText: (text: string) => void,
  shown: boolean
): VoiceInput {
  const [mimeType] = useState(recordingType);
  const { mutate, isPending, error, reset } = useTranscribeVoice(workspaceId);
  const [phase, setPhase] = useState<Exclude<VoicePhase, 'pending'>>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
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
      setAnalyser(next.analyser);
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
    analyser: phase === 'recording' ? analyser : null,
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

/** Bar width and the step to the next bar (with the 3px gap), in px. */
const WAVE_BAR = 2;
const WAVE_STEP = 5;
/** The tallest bar, in px. */
const WAVE_HEIGHT = 22;
/** A new bar this often; the strip slides one step meanwhile. */
const WAVE_SAMPLE_MS = 80;
/** Loudness in dB mapped onto the bar's height, on a curve that keeps
 * syllables apart from pauses: room noise stays a dot and speech (about
 * -25 dB after the browser's gain control) reaches about half. */
const WAVE_FLOOR_DB = -55;
const WAVE_CEILING_DB = -10;

/** A level from 0 to 1 for a stretch of signal. */
function inputLevel(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const db = 10 * Math.log10(sum / samples.length || 1e-10);
  const level = (db - WAVE_FLOOR_DB) / (WAVE_CEILING_DB - WAVE_FLOOR_DB);
  return Math.min(1, Math.max(0, level)) ** 1.5;
}

function motionToken(name: string) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * The input's levels as bars, newest on the right, sliding left as each one
 * arrives and growing leftwards until they fill the space they are given.
 * Each bar keeps the loudest frame since the last, so short syllables show.
 * The bars are DOM nodes animated with the motion tokens: nothing in React
 * re-renders while it records.
 */
export function VoiceWaveform({ analyser }: { analyser: AnalyserNode }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    const strip = stripRef.current;
    if (!(box && strip)) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const grow = {
      duration: still
        ? 0
        : Number.parseFloat(motionToken('--motion-duration-quick')),
      easing: motionToken('--motion-ease-smooth-out'),
    };
    const slide = {
      duration: WAVE_SAMPLE_MS,
      easing: motionToken('--motion-ease-linear'),
    };
    // One more bar than fits: the newest slides in from under the edge.
    let capacity = 0;
    const observer = new ResizeObserver(([entry]) => {
      capacity = Math.floor(entry.contentRect.width / WAVE_STEP) + 1;
    });
    observer.observe(box);
    const samples = new Float32Array(analyser.fftSize);
    let loudest = 0;
    let addedAt = 0;
    let frame = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      analyser.getFloatTimeDomainData(samples);
      loudest = Math.max(loudest, inputLevel(samples));
      if (time - addedAt < WAVE_SAMPLE_MS) return;
      addedAt = time;
      const bar = document.createElement('span');
      const height = `${Math.max(WAVE_BAR, loudest * WAVE_HEIGHT)}px`;
      bar.style.height = height;
      strip.append(bar);
      bar.animate([{ height: `${WAVE_BAR}px` }, { height }], grow);
      while (strip.childElementCount > capacity)
        strip.firstElementChild?.remove();
      if (!still)
        strip.animate(
          [{ transform: `translateX(${WAVE_STEP}px)` }, { transform: 'none' }],
          slide
        );
      loudest = 0;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      strip.replaceChildren();
    };
  }, [analyser]);
  return (
    <span
      aria-hidden
      className="mr-1 flex h-[22px] min-w-0 flex-1 items-center justify-end overflow-hidden"
      ref={boxRef}
    >
      <span
        className="flex shrink-0 items-center gap-[3px] text-action-accent [&>span]:w-[2px] [&>span]:rounded-full [&>span]:bg-current"
        ref={stripRef}
      />
    </span>
  );
}

/** The time a recording has run against the limit, with a pulsing dot, and
 * the input's waveform filling the space before it when the caller has the
 * signal. The time keeps the width of its widest value, so nothing beside it
 * moves as it counts. */
export function VoiceElapsed({
  elapsedMs,
  analyser = null,
  className,
}: {
  elapsedMs: number;
  analyser?: AnalyserNode | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        't-meta flex min-w-0 items-center gap-1.5 whitespace-nowrap text-fg-muted',
        className
      )}
      data-voice-elapsed
    >
      {analyser && <VoiceWaveform analyser={analyser} />}
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-solid-error motion-safe:animate-pulse"
      />
      <span className="min-w-[5.4em] text-right">
        {m.voice_elapsed({
          elapsed: formatClock(elapsedMs),
          limit: formatClock(VOICE_MAX_MS),
        })}
      </span>
    </span>
  );
}

/** The mic button, on a pale purple square while it records and with a
 * spinner while the clip is transcribed; the full composer and the chat dock
 * both show it, and VoiceElapsed beside it while it records. */
export function VoiceButton({
  phase,
  onToggle,
  onMouseDown,
  className,
}: Pick<VoiceInput, 'phase'> & {
  onToggle: () => void;
  /** The dock keeps its field focused through a tap, as its Send does. */
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  /** Overrides the toolbar-sized box. */
  className?: string;
}) {
  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'pending';
  return (
    <IconButton
      aria-pressed={recording}
      className={cn(
        recording
          ? 'bg-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1'
          : 'text-fg-muted hover:text-fg',
        className
      )}
      disabled={busy}
      icon="microphone"
      iconClassName={cn(busy && 'invisible')}
      label={
        phase === 'pending'
          ? m.voice_transcribing()
          : recording
            ? m.voice_stop()
            : m.voice_record()
      }
      onClick={onToggle}
      onMouseDown={onMouseDown}
      size="toolbar"
      tooltip
      variant="ghost-hover"
    >
      {busy && <Spinner className="absolute size-4" />}
    </IconButton>
  );
}
