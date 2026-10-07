import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { clickTextEnd, openEditorNote } from './helpers';

// Switching a note from Edit to View in the same tab renders that tab's live
// document at once, and the projected copy replaces it when the material
// refetch lands, with no loader in between (human/frontend/plate-editor.md).
test('Edit to View shows the live note at once, then the projected copy', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const status = page.getByTestId('editor-save-state');
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  await page.keyboard.type(' saved');
  // A save the room projects, so leaving the editor refetches the material.
  await expect(status).toHaveText('Saved', { timeout: 15_000 });
  await page.keyboard.type(' live');

  // Hold that refetch until released; it then answers with a projected copy
  // whose first block (the heading) is told apart from the live document.
  await page.evaluate(async (id) => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const dbPath = '/src/mocks/db.ts';
    const { worker } = await import(browserPath);
    const { http, HttpResponse } = await import(mswPath);
    const db = await import(dbPath);
    const released = new Promise((resolve) =>
      window.addEventListener('projection-release', resolve, { once: true })
    );
    worker.use(
      http.get(`/api/materials/${id}`, async () => {
        await released;
        const material = structuredClone(
          db.learnerMaterial(db.materials.find((row) => row.id === id))
        );
        material.content.value[0].children = [{ text: 'Projected copy' }];
        return HttpResponse.json(material);
      })
    );
    // From the switch on, a frame with the preview loader (FileLoading) or
    // without the preview once it showed is a flash.
    const flashes: string[] = [];
    (window as unknown as { __flashes: string[] }).__flashes = flashes;
    let seen = false;
    const check = () => {
      const preview = document.querySelector(
        '[data-testid="material-preview"]'
      );
      if (preview) seen = true;
      else if (seen) flashes.push('preview gone');
      if (document.body.innerText.includes('Loading preview'))
        flashes.push('loader');
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, EDITOR_NOTE.id);

  await page
    .getByRole('button', { exact: true, name: 'Material mode' })
    .click();
  const preview = page.getByTestId('material-preview');
  // While the refetch is held, only the live document has the last word.
  await expect(preview).toContainText(
    `${EDITOR_NOTE.firstParagraph} saved live`
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event('projection-release'))
  );
  await expect(preview).toContainText('Projected copy');
  await expect(preview).not.toContainText(EDITOR_NOTE.headingText);
  await expect(preview).toContainText(EDITOR_NOTE.secondParagraph);
  expect(
    await page.evaluate(
      () => (window as unknown as { __flashes: string[] }).__flashes
    )
  ).toEqual([]);
});
