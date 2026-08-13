import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import { m } from '@/i18n';

/** Records microphone audio via MediaRecorder and transcribes it through the
 * gateway's /transcribe (Whisper) endpoint. `toggle` starts/stops; on stop the
 * blob is uploaded and the resulting transcript is delivered via onText. */
export function useVoiceInput(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(m.editor_mic_unsupported());
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        cleanup();
        setRecording(false);
        if (blob.size === 0) return;
        setBusy(true);
        try {
          const form = new FormData();
          form.append('file', blob, 'audio.webm');
          const res = await api.upload<{ text?: string }>('/transcribe', form);
          if (res?.text) onText(res.text);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      setError((e as Error).message);
      cleanup();
    }
  }, [cleanup, onText]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { busy, error, recording, toggle };
}
