/** A saved answer as text. Spreading all its bytes into one call throws from about
 * 100 KB, past the engine's argument limit, so they go in chunks. */
export function toBase64(bytes: Uint8Array) {
  const CHUNK = 0x80_00;
  let text = '';
  for (let start = 0; start < bytes.length; start += CHUNK)
    text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  return btoa(text);
}

/** The browser's own decoder where there is one, else a plain loop: `Uint8Array.from`
 * with a mapper took 9 ms on a 300 KB board, and a list draws hundreds of previews. */
export function fromBase64(saved: string) {
  const typed = Uint8Array as { fromBase64?: (text: string) => Uint8Array };
  if (typed.fromBase64) return typed.fromBase64(saved);
  const text = atob(saved);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
