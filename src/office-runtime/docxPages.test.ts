import { readFileSync } from 'node:fs';
import { initWasm, openDocumentViewer } from '@betteroffice/docx/viewer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DocxPage, packDocxPages } from './docxPages';

const fork = (path: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../vendor/betteroffice/${path}`, import.meta.url))
  );
// Node cannot fetch the packaged wasm URL: the viewer takes its bytes.
beforeAll(() =>
  initWasm(
    fork('packages/docx/src/wasm/generated/viewer/docx_view_wasm_bg.wasm')
  )
);
afterEach(() => vi.unstubAllGlobals());

/** The pages the viewer lays out for a fixture: glyph runs, headers,
 * footers, notes, images and shapes. */
async function fixturePages() {
  const viewer = await openDocumentViewer(
    fork('poc/fixtures/wordprocessingml-comprehensive.docx')
  );
  const { pages } = viewer.displayList();
  viewer.dispose();
  return pages;
}

it('keeps each page until it is packed, then decodes the same page from its deflated JSON each time', async () => {
  const pages = await fixturePages();
  expect(pages.some((page) => page.noteAreas?.length)).toBe(true);
  const kept = pages.map((page) => new DocxPage(page));
  expect(kept[1]).toMatchObject({
    height: pages[1]!.height,
    pageIndex: 1,
    width: pages[1]!.width,
  });
  expect(kept[1]!.decode()).toBe(pages[1]);

  // Idle at once, for 50 ms.
  vi.stubGlobal('requestIdleCallback', (run: IdleRequestCallback) =>
    setTimeout(() => run({ didTimeout: false, timeRemaining: () => 50 }))
  );
  packDocxPages(kept);
  await vi.waitFor(() => expect(kept.every((page) => page.packed)).toBe(true));
  for (const [index, page] of kept.entries()) {
    const decoded = page.decode();
    expect(decoded).toStrictEqual(pages[index]);
    expect(decoded).not.toBe(pages[index]);
    expect(page.decode()).not.toBe(decoded);
  }
});

it('packs in slices that end with the idle time left', async () => {
  const idle: ((deadline: IdleDeadline) => void)[] = [];
  vi.stubGlobal(
    'requestIdleCallback',
    (run: (deadline: IdleDeadline) => void) => idle.push(run)
  );
  const pages = (await fixturePages()).map((page) => new DocxPage(page));
  packDocxPages(pages);
  await vi.waitFor(() => expect(idle).toHaveLength(1));

  // An idle period already over packs nothing and waits for the next.
  idle.shift()!({ didTimeout: false, timeRemaining: () => 0 });
  expect(pages.some((page) => page.packed)).toBe(false);
  expect(idle).toHaveLength(1);
  idle.shift()!({ didTimeout: false, timeRemaining: () => 50 });
  expect(pages.some((page) => page.packed)).toBe(true);
});
