// pdf.js ships its image decoders without declarations; the JPEG 2000 one
// decodeImage.ts loads.
declare module 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs' {
  export const JpxImage: {
    /** Gray, RGB or RGBA bytes, as many components as the image holds;
     * throws on a file it cannot decode. */
    decode(
      data: Uint8Array,
      options: Record<string, never>
    ): Uint8ClampedArray<ArrayBuffer>;
    parseImageProperties(data: Uint8Array): { height: number; width: number };
  };
}
