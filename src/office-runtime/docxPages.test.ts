import type { DisplayPage } from '@betteroffice/docx/layout/render';
import { expect, it } from 'vitest';
import { DocxPage, sentDocxPage } from './docxPages';

const page = {
  height: 1056,
  pageIndex: 3,
  primitives: [
    { color: '#000000', kind: 'text', text: '交換 Exchange', x: 96, y: 120 },
  ],
  width: 816,
} as unknown as DisplayPage;

it('keeps a page as its JSON, decoding the same page before and after it is deflated', () => {
  const sent = sentDocxPage(page);
  const kept = new DocxPage(sent);
  expect(kept).toMatchObject({ height: 1056, pageIndex: 3, width: 816 });
  expect(kept.decode()).toEqual(page);
  kept.pack();
  expect(kept.packed).toBe(true);
  expect(kept.decode()).toEqual(page);
  // The JSON it came as is released at once, not left for a collection.
  expect(sent.json.byteLength).toBe(0);
});
