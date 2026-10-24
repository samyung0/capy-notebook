import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** How long the dialog waits for the browser to read a length. */
export const AUDIO_DURATION_READ_MS = 5000;

// A seek this far makes the browser find the end of a file that names no
// length.
const PAST_THE_END_S = 1e101;

const usable = (seconds: number) =>
  Number.isFinite(seconds) && seconds > 0 ? seconds : null;

/** The length the browser reads from an audio file, or null when it cannot
 * within `AUDIO_DURATION_READ_MS`. The worker measures it again and holds
 * the two-hour limit. */
export function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const finish = (duration: number | null) => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.ondurationchange = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    // Some browsers defer loading a detached element's media.
    const timer = setTimeout(() => finish(null), AUDIO_DURATION_READ_MS);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (audio.duration !== Number.POSITIVE_INFINITY) {
        finish(usable(audio.duration));
        return;
      }
      // A recorder's WebM or Ogg names no length until the end is read.
      const found = () => {
        if (Number.isFinite(audio.duration)) finish(usable(audio.duration));
      };
      audio.ondurationchange = found;
      audio.ontimeupdate = found;
      audio.currentTime = PAST_THE_END_S;
    };
    audio.onerror = () => finish(null);
    audio.src = url;
    audio.load();
  });
}

/** A local audio file's length for its credit estimate. A length the browser
 * cannot read means a cost nobody can estimate, so the file is refused: a
 * toast names it, and the caller drops its row. */
export async function audioLengthOrRefuse(file: File): Promise<number | null> {
  const seconds = await readAudioDuration(file);
  if (seconds == null) {
    userToast({
      title: m.source_audio_length_unreadable({ name: file.name }),
      variant: 'error',
    });
  }
  return seconds;
}
