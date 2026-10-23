/** How long the dialog waits for the browser to read a length. Past it the
 * length is unknown: the worker measures every file anyway. */
export const AUDIO_DURATION_READ_MS = 5000;

/** The length the browser reads from an audio file's metadata, or null when
 * it cannot within `AUDIO_DURATION_READ_MS`. The worker measures it again and
 * holds the two-hour limit. */
export function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const finish = (duration: number | null) => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    // Some browsers defer loading a detached element's media.
    const timer = setTimeout(() => finish(null), AUDIO_DURATION_READ_MS);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : null
      );
    audio.onerror = () => finish(null);
    audio.src = url;
    audio.load();
  });
}
