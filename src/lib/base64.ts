/** Standard base64 of bytes (comment anchors, presence positions, a mock
 * room's kept board). Spread in chunks: one call takes about 100 KB at most. */
export function bytesToBase64(value: Uint8Array): string {
  const CHUNK = 0x80_00;
  let binary = '';
  for (let start = 0; start < value.length; start += CHUNK)
    binary += String.fromCharCode(...value.subarray(start, start + CHUNK));
  return btoa(binary);
}

/** The bytes of standard base64; throws on anything else (`atob`). A plain
 * loop: `Uint8Array.from` with a mapper took 0.76 s on a 4 MiB board at 4x. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
