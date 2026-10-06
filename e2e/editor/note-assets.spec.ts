import { expect, test } from '@playwright/test';
import { openEditorNote } from './helpers';

test('a deleted image keeps its bytes on this device and comes back on undo', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const image = editor.locator('img[src^="data:image/svg+xml"]');
  await expect(image).toHaveCount(1);

  await image.click({ button: 'right' });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(image).toHaveCount(0);

  // The removed asset's bytes land in this session's IndexedDB rows.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve, reject) => {
            const opening = indexedDB.open('capy-local-msw');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
              const rows = opening.result
                .transaction('keptAssets')
                .objectStore('keptAssets')
                .getAll();
              rows.onsuccess = () => {
                opening.result.close();
                resolve(
                  (rows.result as { assetId: string }[]).map(
                    (row) => row.assetId
                  )
                );
              };
            };
          })
      )
    )
    .toEqual(['asset_mock_cell_diagram']);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(image).toHaveCount(1);
  await expect(image).toBeVisible();
});
