import { delay, HttpResponse, http } from 'msw';
import type { VoiceTranscription } from '@/api/types';

/** Chat voice input: any accepted clip "says" one question about the
 * biology fixtures after a provider-like pause; other types are refused as
 * the gateway does. */
export const voiceInputHandlers = [
  '/api/workspaces/:id/voice-transcriptions',
  '/api/voice-transcriptions',
].map((path) =>
  http.post(path, async ({ request }) => {
    const type = request.headers.get('Content-Type')?.split(';')[0];
    if (!(type && ['audio/webm', 'audio/ogg', 'audio/mp4'].includes(type)))
      return HttpResponse.json(
        { errors: [{ message: 'voice_format_unsupported' }], status: 415 },
        { status: 415 }
      );
    await delay(1200);
    return HttpResponse.json<VoiceTranscription>({
      text: 'What does the Krebs cycle produce, and where in the cell does it happen?',
    });
  })
);
