import type { DisplayPage } from '@betteroffice/docx/layout/render';
import { expect, it } from 'vitest';
import { DocxPage } from './docxPages';

const page = {
  height: 1056,
  pageIndex: 3,
  primitives: [
    { color: '#000000', kind: 'text', text: '交換 Exchange', x: 96, y: 120 },
  ],
  width: 816,
} as unknown as DisplayPage;

it('keeps a page until it is packed, then decodes the same page from its deflated JSON each time', () => {
  const kept = new DocxPage(page);
  expect(kept).toMatchObject({ height: 1056, pageIndex: 3, width: 816 });
  expect(kept.decode()).toBe(page);
  kept.pack();
  expect(kept.packed).toBe(true);
  const decoded = kept.decode();
  expect(decoded).toEqual(page);
  expect(decoded).not.toBe(page);
  expect(kept.decode()).not.toBe(decoded);
});
