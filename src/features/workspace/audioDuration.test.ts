import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import {
  AUDIO_DURATION_READ_MS,
  audioLengthOrRefuse,
  readAudioDuration,
} from './audioDuration';

const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));

/** An audio element that loads nothing until the test says so. */
function stalledAudio() {
  const audio = {
    currentTime: 0,
    duration: Number.NaN,
    load: vi.fn(),
    ondurationchange: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onloadedmetadata: null as (() => void) | null,
    ontimeupdate: null as (() => void) | null,
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
    userToast.mockReset();
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

  it('seeks past the end of a recording that names no length to find it', async () => {
    const audio = stalledAudio();
    const read = readAudioDuration(new File(['x'], 'recording.webm'));

    audio.duration = Number.POSITIVE_INFINITY;
    audio.onloadedmetadata?.();
    expect(audio.currentTime).toBeGreaterThan(1e100);
    audio.ontimeupdate?.(); // Still Infinity: keep waiting.
    audio.duration = 95.25;
    audio.ondurationchange?.();

    await expect(read).resolves.toBe(95.25);
  });

  it('has no length for a zero duration', async () => {
    const audio = stalledAudio();
    const read = readAudioDuration(new File(['x'], 'empty.wav'));

    audio.duration = 0;
    audio.onloadedmetadata?.();

    await expect(read).resolves.toBeNull();
  });

  it('refuses a file whose length cannot be read with a toast naming it', async () => {
    vi.useFakeTimers();
    stalledAudio();
    const read = audioLengthOrRefuse(new File(['x'], 'lecture.webm'));

    await vi.advanceTimersByTimeAsync(AUDIO_DURATION_READ_MS);

    await expect(read).resolves.toBeNull();
    expect(userToast).toHaveBeenCalledWith({
      title: m.source_audio_length_unreadable({ name: 'lecture.webm' }),
      variant: 'error',
    });
  });

  it('keeps a file whose length it read without a toast', async () => {
    const audio = stalledAudio();
    const read = audioLengthOrRefuse(new File(['x'], 'lecture.mp3'));

    audio.duration = 30;
    audio.onloadedmetadata?.();

    await expect(read).resolves.toBe(30);
    expect(userToast).not.toHaveBeenCalled();
  });
});
