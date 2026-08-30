import { CSV_PREVIEW_MAX_BYTES, parseCsvPreview } from './csvPreviewCore';

interface PreviewRequest {
  type: 'preview';
  url: string;
}

async function boundedFetch(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > CSV_PREVIEW_MAX_BYTES) {
    throw new Error('Delimited file exceeds the preview byte limit');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > CSV_PREVIEW_MAX_BYTES) {
      throw new Error('Delimited file exceeds the preview byte limit');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > CSV_PREVIEW_MAX_BYTES) {
      await reader.cancel();
      throw new Error('Delimited file exceeds the preview byte limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

self.addEventListener('message', (event: MessageEvent<PreviewRequest>) => {
  if (event.data.type !== 'preview') return;
  void boundedFetch(event.data.url).then(
    (bytes) => {
      self.postMessage({ result: parseCsvPreview(bytes), type: 'result' });
    },
    (value: unknown) => {
      self.postMessage({
        message: value instanceof Error ? value.message : String(value),
        type: 'error',
      });
    }
  );
});
