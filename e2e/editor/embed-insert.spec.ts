import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { clickTextEnd, openEditorNote } from './helpers';

// The slash menu's quiz creates its row before the block goes in. Whatever the
// user does during that round trip stays: the block lands where the command
// ran and the caret stays where the user went.
test('a quiz lands where its command ran while the user types elsewhere', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  // Hold the create request until released, then let the mock answer it.
  await page.evaluate(async () => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const { worker } = await import(browserPath);
    const { http } = await import(mswPath);
    const state = window as unknown as { __embedHeld?: boolean };
    const released = new Promise((resolve) =>
      window.addEventListener('embed-release', resolve, { once: true })
    );
    worker.use(
      http.post('/api/materials/:id/embedded', async () => {
        state.__embedHeld = true;
        await released;
      })
    );
  });

  const first = editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true });
  await clickTextEnd(first);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/quiz');
  await page.getByRole('option', { exact: true, name: 'Quiz' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __embedHeld?: boolean }).__embedHeld
  );

  const third = editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true });
  await clickTextEnd(third);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('typed during');
  await page.evaluate(() => window.dispatchEvent(new Event('embed-release')));
  const quiz = editor.locator('.slate-material_ref');
  await expect(quiz).toHaveCount(1);
  await expect(quiz.getByText('Add question', { exact: true })).toBeVisible();
  await page.keyboard.type(' and after');

  const typed = editor.getByText('typed during and after', { exact: true });
  await expect(typed).toBeVisible();
  const top = async (locator: typeof quiz) => (await locator.boundingBox())!.y;
  const second = editor.getByText(EDITOR_NOTE.secondParagraph, {
    exact: true,
  });
  expect(await top(quiz)).toBeGreaterThan(await top(first));
  expect(await top(quiz)).toBeLessThan(await top(second));
  expect(await top(typed)).toBeGreaterThan(await top(third));
});

// The slash input removes itself, re-selects and focuses before the command
// runs; the caret it leaves is where the quiz must go, and the quiz takes it.
test('a quiz takes its line and the caret when the caret stayed', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const first = editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true });
  await clickTextEnd(first);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/quiz');
  await page.getByRole('option', { exact: true, name: 'Quiz' }).click();
  const quiz = editor.locator('.slate-material_ref');
  await expect(quiz).toHaveCount(1);
  const top = async (locator: typeof quiz) => (await locator.boundingBox())!.y;
  const second = editor.getByText(EDITOR_NOTE.secondParagraph, {
    exact: true,
  });
  expect(await top(quiz)).toBeGreaterThan(await top(first));
  expect(await top(quiz)).toBeLessThan(await top(second));
  // The caret sits on the quiz.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!window
            .getSelection()
            ?.anchorNode?.parentElement?.closest('.slate-material_ref')
      )
    )
    .toBe(true);
});
