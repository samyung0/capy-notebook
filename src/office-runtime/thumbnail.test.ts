import { describe, expect, it } from 'vitest';
import { imageOnlyWebP } from './thumbnail';

// A capture as Chrome's OffscreenCanvas.convertToBlob encodes it: VP8X with
// the ICC flag, a 456-byte ICCP sRGB profile, then the 450-byte VP8 image.
const chrome = Uint8Array.from(
  atob(
    'UklGRrADAABXRUJQVlA4WAoAAAAgAAAAxwAAcAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRy' +
      'UkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA' +
      '9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
      'AAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAA' +
      'ABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0' +
      'AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAA' +
      'b6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVog' +
      'AAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAA' +
      'AABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAg' +
      'ADIAMAAxADZWUDggwgEAALAOAJ0BKsgAcQA+tVqpTyclpCIhmZmI4BaJZ27hceDoGEu8vvgI' +
      'wC6AlQPag9d9AAWEs9PvWN3rG71jd6xu9Y3esbvWN1x3MFBLEs7VRu9YdPpZbsEvzokVL5XU' +
      'D88VADSCvsrJic2UgOO89PvWN3jHYlAhx5aZsEXTJvZaAAD+/Ufrm59aRBAAAAAAQB4fgyrV' +
      'mkG6Uj+JniP24m6Hz0xtSoe+jqE63Yry5bgGE9TOq9Yzv+Lapd/fd4LjK4gKwyOWFTbi87sE' +
      'xgqdg/ghNjuAVFjrJ6mZn8OvetqfaxZfnZIz/oPRLQUqron71Ft7oaMnSDq4cTgtwOe7Z4ts' +
      '0WHbiLM37GVlKDwrzLdIuEyslUXRhuLa+9W3r3NconyznW3Texi66cv8zFjDcfkMCxqGFyn8' +
      'AiO3hAU5KqzudLj0gs1PpgcMwqoL/8KWqCmz5gEnRPuz4jv+TqeNBEVR1WPTiuOm4QaleDk0' +
      '5hrPOJSdDUK+Y0YDi71gqzs4hKvP6pQ54Xm4pVLBsxfsT1teJtmtYD4LDooi2LHj4lUaKlSF' +
      'gAAABbfkjHulNMt3C6o7q8qjuryqO6vKo7q8qjuryoOAAA=='
  ),
  (c) => c.charCodeAt(0)
).buffer;

const chunkIds = (webp: ArrayBuffer) => {
  const view = new DataView(webp);
  const ids: string[] = [];
  for (let at = 12; at < webp.byteLength; ) {
    ids.push(String.fromCharCode(...new Uint8Array(webp, at, 4)));
    const size = view.getUint32(at + 4, true);
    at += 8 + size + (size % 2);
  }
  return ids;
};

describe('a capture as Go takes it', () => {
  it('keeps only the image chunk of a Chrome capture', () => {
    expect(chunkIds(chrome)).toEqual(['VP8X', 'ICCP', 'VP8 ']);
    const image = imageOnlyWebP(chrome);
    expect(chunkIds(image)).toEqual(['VP8 ']);
    expect(image.byteLength).toBe(12 + 8 + 450);
    // The RIFF size covers the rest exactly, and the image bytes are Chrome's.
    expect(new DataView(image).getUint32(4, true)).toBe(image.byteLength - 8);
    expect(new Uint8Array(image).slice(12)).toEqual(
      new Uint8Array(chrome).slice(chrome.byteLength - 458)
    );
    // A capture already in that form stays the same.
    expect(new Uint8Array(imageOnlyWebP(image))).toEqual(new Uint8Array(image));
  });
});
