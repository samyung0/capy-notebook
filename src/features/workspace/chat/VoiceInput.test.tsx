import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { m } from '@/i18n';
import { VoiceButton } from './VoiceInput';
import {
  insertTranscript,
  micErrorMessage,
  recordingType,
  startRecording,
  VOICE_MAX_MS,
  voiceErrorMessage,
} from './voiceRecording';

// No DOM here: the browser's recorder and microphone are stand-ins that keep
// what the composer did to them.
class FakeRecorder {
  static supported = ['audio/webm;codecs=opus'];
  static last: FakeRecorder | null = null;
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.includes(type);
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  options: MediaRecorderOptions;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    this.options = options;
    this.mimeType = options.mimeType ?? '';
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['opus'], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

function microphone(answer: () => Promise<unknown>) {
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => {
    await answer();
    return { getTracks: () => [track] };
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { getUserMedia, track };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  FakeRecorder.supported = ['audio/webm;codecs=opus'];
});

describe('chat voice input', () => {
  it('records, sends the clip as its own type, and inserts the text at the caret', async () => {
    const { track } = microphone(async () => undefined);
    const type = recordingType();
    expect(type).toBe('audio/webm;codecs=opus');
    const clips: Blob[] = [];
    const recording = await startRecording(type as string, (clip) =>
      clips.push(clip)
    );
    expect(FakeRecorder.last?.options.audioBitsPerSecond).toBe(32_000);
    expect(track.stop).not.toHaveBeenCalled();
    recording.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(clips.map((clip) => clip.type)).toEqual(['audio/webm;codecs=opus']);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'the Krebs cycle' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { text } = await api.postBlob<{ text: string }>(
      '/workspaces/ws_1/voice-transcriptions',
      clips[0]
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('/api/workspaces/ws_1/voice-transcriptions');
    expect(init.headers['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(init.body).toBe(clips[0]);

    // The caret sat after "Explain"; the text is never sent by itself.
    expect(insertTranscript('Explain please', text, 7, 7)).toEqual({
      caret: 23,
      value: 'Explain the Krebs cycle please',
    });
    expect(insertTranscript('解释', '三羧酸循环', 2, 2).value).toBe(
      '解释三羧酸循环'
    );
    expect(insertTranscript('', text, 0, 0).value).toBe('the Krebs cycle');
  });

  it('stops by itself at the two-minute limit, and a cancel keeps no clip', async () => {
    vi.useFakeTimers();
    const { track } = microphone(async () => undefined);
    const clips: Blob[] = [];
    await startRecording('audio/webm;codecs=opus', (clip) => clips.push(clip));
    vi.advanceTimersByTime(VOICE_MAX_MS - 1);
    expect(clips).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(clips).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledOnce();

    const cancelled = await startRecording('audio/webm;codecs=opus', (clip) =>
      clips.push(clip)
    );
    cancelled.cancel();
    expect(clips).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledTimes(2);
  });

  it('records AAC where Opus is missing, and hides where nothing records', () => {
    FakeRecorder.supported = ['audio/mp4'];
    microphone(async () => undefined);
    expect(recordingType()).toBe('audio/mp4');
    vi.stubGlobal('navigator', {});
    expect(recordingType()).toBeNull();
  });

  it('shows a blocked microphone and the gateway refusals inline', async () => {
    microphone(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const denied = await startRecording('audio/webm;codecs=opus', () => {
      throw new Error('no clip');
    }).catch((error: unknown) => error);
    expect(micErrorMessage(denied)).toBe(m.voice_mic_denied());
    expect(micErrorMessage(new DOMException('none', 'NotFoundError'))).toBe(
      m.voice_mic_failed()
    );

    const refusal = (status: number, code?: string) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify(code ? { errors: [{ message: code }] } : {}),
              { status }
            )
        )
      );
      return api
        .postBlob('/workspaces/ws_1/voice-transcriptions', new Blob(['x']))
        .catch((error: unknown) => voiceErrorMessage(error));
    };
    expect(await refusal(429, 'transcription_busy')).toBe(m.voice_error_busy());
    expect(await refusal(429, 'ai_rate_limited')).toBe(m.voice_error_busy());
    expect(await refusal(413)).toBe(m.voice_error_too_long({ minutes: 2 }));
    expect(await refusal(422, 'voice_too_long')).toBe(
      m.voice_error_too_long({ minutes: 2 })
    );
    expect(await refusal(422, 'voice_no_speech')).toBe(
      m.voice_error_no_speech()
    );
    expect(await refusal(502, 'transcription_failed')).toBe(
      m.voice_error_failed()
    );
  });

  it('draws the elapsed time against the limit while recording, and waits while transcribing', () => {
    const recording = renderToStaticMarkup(
      <VoiceButton elapsedMs={42_500} onToggle={() => {}} phase="recording" />
    );
    expect(recording).toContain(
      m.voice_elapsed({ elapsed: '0:42', limit: '2:00' })
    );
    expect(recording).toContain('aria-pressed="true"');
    expect(recording).toContain(m.voice_stop());

    const pending = renderToStaticMarkup(
      <VoiceButton elapsedMs={0} onToggle={() => {}} phase="pending" />
    );
    expect(pending).toContain('disabled');
    expect(pending).toContain('data-slot="spinner"');
    expect(pending).toContain(m.voice_transcribing());
  });
});
