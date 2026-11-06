/** A saved answer as text. Spreading all its bytes into one call throws from about
 * 100 KB, past the engine's argument limit, so they go in chunks. */
export function toBase64(bytes: Uint8Array) {
  const CHUNK = 0x80_00;
  let text = '';
  for (let start = 0; start < bytes.length; start += CHUNK)
    text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  return btoa(text);
}

export function fromBase64(saved: string) {
  return Uint8Array.from(atob(saved), (char) => char.charCodeAt(0));
}
