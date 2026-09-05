import { MATERIAL_DOCUMENT_LIMITS } from './limits.js';

// A replace-block command carries both the expected and replacement blocks.
// Each may be almost as large as one valid material document.
export const MAX_INTERNAL_COMMAND_BODY_BYTES =
  2 * MATERIAL_DOCUMENT_LIMITS.maxContentBytes + 1024 * 1024;

export async function readInternalCommandJson(
  request: AsyncIterable<Buffer | string | Uint8Array>
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INTERNAL_COMMAND_BODY_BYTES) {
      throw new Error('command body is too large');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
