/**
 * Chat voice input (openwiki/agentic-retrieval.md, Chat voice input): the
 * composer records at most VOICE_INPUT_MAX_SECONDS with MediaRecorder, the
 * gateway transcribes the clip, and the text is inserted for the user to edit
 * and send. Nothing is sent automatically, and nothing retries.
 */
import { isApiError } from '@/api/client';
import { VOICE_INPUT_MAX_SECONDS } from '@/api/limits.generated';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

export const VOICE_MAX_MS = VOICE_INPUT_MAX_SECONDS * 1000;

/** The containers the gateway takes: Opus in WebM or Ogg where the browser
 * records it, else Safari's AAC in MP4. */
const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/** Speech needs little: two minutes at 32 kb/s is about 0.5 MB, well under
 * the gateway's 2 MiB limit. */
const AUDIO_BITS_PER_SECOND = 32_000;

/** The type this browser records in, or null where it cannot record (no
 * MediaRecorder or getUserMedia), which hides the button. */
export function recordingType(): string | null {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  )
    return null;
  return (
    RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

export interface Recording {
  /** Ends it without a clip (the composer went away). */
  cancel: () => void;
  /** Ends the recording; the clip goes to onClip. */
  stop: () => void;
}

/**
 * Asks for the microphone and records until stop, cancel or the two-minute
 * limit. The microphone's tracks stop whenever the recording ends.
 */
export async function startRecording(
  mimeType: string,
  onClip: (clip: Blob) => void
): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      mimeType,
    });
  } catch (error) {
    release();
    throw error;
  }
  const chunks: Blob[] = [];
  let keep = true;
  const end = (withClip: boolean) => {
    keep &&= withClip;
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const limit = setTimeout(() => end(true), VOICE_MAX_MS);
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    clearTimeout(limit);
    release();
    if (keep && chunks.length)
      onClip(new Blob(chunks, { type: recorder.mimeType || mimeType }));
  };
  recorder.start();
  return { cancel: () => end(false), stop: () => end(true) };
}

/** A getUserMedia failure: refused permission, or no usable microphone. */
export function micErrorMessage(error: unknown): string {
  return error instanceof DOMException && error.name === 'NotAllowedError'
    ? m.voice_mic_denied()
    : m.voice_mic_failed();
}

/** The gateway's refusal of a clip, as the composer shows it. */
export function voiceErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    // The provider's throttling (transcription_busy) or our own rate limit.
    if (error.status === 429) return m.voice_error_busy();
    if (error.status === 413 || error.code === 'voice_too_long')
      return m.voice_error_too_long({ minutes: VOICE_INPUT_MAX_SECONDS / 60 });
    if (error.code === 'voice_no_speech') return m.voice_error_no_speech();
    if (
      error.code === 'transcription_failed' ||
      error.code === 'voice_unavailable' ||
      error.code === 'voice_format_unsupported'
    )
      return m.voice_error_failed();
  }
  // Credits, a frozen account, offline and the like keep their usual copy.
  return errorCopy(error, m.voice_error_failed());
}

/** Whitespace, and CJK (U+2E80-U+9FFF, Hangul syllables, compatibility
 * ideographs, full-width forms), which is written without spaces. */
const UNSPACED = /[\s⺀-鿿가-힯豈-﫿＀-￯]/;

/** Whether two characters written next to each other need a space between
 * them. */
function spaced(before: string | undefined, after: string | undefined) {
  return !!before && !!after && !UNSPACED.test(before) && !UNSPACED.test(after);
}

/**
 * The composer's text with a transcript in place of its selection (the caret
 * when nothing is selected), and where the caret goes after it.
 */
export function insertTranscript(
  value: string,
  transcript: string,
  start: number,
  end: number
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = spaced(before.at(-1), transcript[0]) ? ' ' : '';
  const trail = spaced(transcript.at(-1), after[0]) ? ' ' : '';
  const inserted = lead + transcript + trail;
  return {
    caret: before.length + lead.length + transcript.length,
    value: before + inserted + after,
  };
}
