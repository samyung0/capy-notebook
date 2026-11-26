import { expect, it } from 'vitest';
import { jpegPagesPdf } from './pagesPdf';

const START_XREF = /startxref\n(\d+)/;
const XREF_ENTRY = /(\d{10}) 00000 n/g;

it('writes each page with a cross-reference a reader can follow', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const page = (width: number) => ({
    jpeg,
    pixels: { height: 20, width: 10 },
    points: { height: 792, width },
  });
  const pdf = jpegPagesPdf([page(612), page(595.5)]);
  const text = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
  expect(text).toContain('/Kids [3 0 R 6 0 R] /Count 2');
  expect(text).toContain('/MediaBox [0 0 595.5 792]');
  const xref = Number(START_XREF.exec(text)?.[1]);
  expect(text.slice(xref, xref + 4)).toBe('xref');
  const offsets = [...text.slice(xref).matchAll(XREF_ENTRY)].map((match) =>
    Number(match[1])
  );
  expect(offsets).toHaveLength(8);
  offsets.forEach((offset, i) => {
    expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
  });
});
