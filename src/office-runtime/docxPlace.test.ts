import { afterEach, expect, it, vi } from 'vitest';
import { restoreTopParagraph } from './docxPlace';

afterEach(() => vi.unstubAllGlobals());

// The handover's last step (Q815 C): the top paragraph's page is not built
// when the box scrolls there, so its fragment exists only once the editor has
// built the pages in view.
it('puts the top paragraph back once the pages in view are built', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  let built = false;
  const fragment = { getBoundingClientRect: () => ({ top: 130 }) };
  const area = {
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: (selector: string) =>
      built && selector.includes('[data-para-id="p7"][data-from-line="2"]')
        ? fragment
        : null,
    scrollTop: 1000,
  } as unknown as HTMLElement;
  await restoreTopParagraph(
    area,
    { line: 2, offset: 10, paraId: 'p7' },
    async () => {
      built = true;
    }
  );
  expect(area.scrollTop).toBe(1020);
});
