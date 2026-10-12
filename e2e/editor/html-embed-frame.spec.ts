import { expect, test } from '@playwright/test';

// The feature matrix's interactive block holds a `width:100%` range input,
// whose default side margins made the snippet 4px wider than its frame: a
// horizontal scrollbar, which then took height and added a vertical one, in
// the editor and on shared notes alike (both render HtmlEmbed). The frame page
// (embed/index.html) now zeroes those margins and sizes the frame for them.
test('an interactive block fits its frame with nothing to scroll', async ({
  page,
}) => {
  await page.goto('/materials/mat_note_bio_feature_matrix');
  const frame = page.locator('iframe[sandbox="allow-scripts"]');
  await expect(frame).toHaveCount(1, { timeout: 30_000 });
  const snippet = await (await frame.elementHandle())?.contentFrame();
  if (!snippet) throw new Error('The interactive block has no frame.');
  await expect
    .poll(
      () =>
        snippet.evaluate(() => {
          const root = document.documentElement;
          return {
            range: document.querySelectorAll('input[type=range]').length,
            tallerBy: root.scrollHeight - root.clientHeight,
            widerBy: root.scrollWidth - root.clientWidth,
          };
        }),
      { timeout: 30_000 }
    )
    .toEqual({ range: 1, tallerBy: 0, widerBy: 0 });
});
