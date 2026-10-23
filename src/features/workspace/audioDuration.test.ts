import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_DURATION_READ_MS, readAudioDuration } from './audioDuration';

/** An audio element that loads nothing until the test says so. */
function stalledAudio() {
  const audio = {
    duration: Number.NaN,
    load: vi.fn(),
    onerror: null as (() => void) | null,
    onloadedmetadata: null as (() => void) | null,
    preload: '',
    removeAttribute: vi.fn(),
    src: '',
  };
  vi.stubGlobal('document', { createElement: () => audio });
  return audio;
}

describe('readAudioDuration', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gives up on a read that never answers', async () => {
    vi.useFakeTimers();
    const audio = stalledAudio();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const read = readAudioDuration(new File(['x'], 'lecture.webm'));

    // The element is asked to load, not left to a browser that defers it.
    expect(audio.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUDIO_DURATION_READ_MS);

    await expect(read).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(audio.onloadedmetadata).toBeNull();
  });

  it('reads the length the metadata gives', async () => {
    const audio = stalledAudio();
    const read = readAudioDuration(new File(['x'], 'lecture.mp3'));

    audio.duration = 61.5;
    audio.onloadedmetadata?.();

    await expect(read).resolves.toBe(61.5);
  });

  it('has no length for a recording that names none', async () => {
    const audio = stalledAudio();
    const read = readAudioDuration(new File(['x'], 'recording.webm'));

    audio.duration = Number.POSITIVE_INFINITY;
    audio.onloadedmetadata?.();

    await expect(read).resolves.toBeNull();
  });
});
