import type { MaterialDocument } from '@/features/materials/document';
import { markdownToDocument } from '@/features/notes/markdownConvert';

export interface MarkdownPreviewRequest {
  id: number;
  text: string;
}

export type MarkdownPreviewResponse = { id: number } & (
  | { document: MaterialDocument; type: 'result' }
  | { type: 'error' }
);

/** Converts uploaded markdown files' text off the main thread. */
self.addEventListener(
  'message',
  ({ data: { id, text } }: MessageEvent<MarkdownPreviewRequest>) => {
    let response: MarkdownPreviewResponse;
    try {
      response = { document: markdownToDocument(text), id, type: 'result' };
    } catch {
      response = { id, type: 'error' };
    }
    self.postMessage(response);
  }
);
