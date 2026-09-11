/** Consume an SSE response body and pass each complete event to the caller. */
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (chunk: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        onEvent(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) onEvent(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** Join the `data:` lines of one SSE chunk. Returns "" for the comment-only
 * chunks (`: ping`) the server sends to keep proxies from dropping the
 * connection — those carry no payload. */
export function sseData(chunk: string): string {
  return chunk
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
}

/** The `event:` name of one SSE chunk, "" when the server sent none. */
export function sseEvent(chunk: string): string {
  const line = chunk.split('\n').find((entry) => entry.startsWith('event:'));
  return line ? line.slice(6).trim() : '';
}
