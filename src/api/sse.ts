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
