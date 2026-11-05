import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Epo 2026-11-05: a room refusing someone leaves the page as it is: an editor
// goes read-only under a strip saying so. Only a refused read ends what shows.
const refuseRooms = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseOpenRooms } = await import(path);
    return refuseOpenRooms() as number;
  });

for (const [name, url, text] of [
  [
    'note',
    '/workspaces/ws_bio?material=mat_note_1',
    'Prokaryotes vs eukaryotes',
  ],
  ['quiz', '/workspaces/ws_bio?material=qz_bio_near', null],
  ['text file', '/workspaces/ws_bio?file=f_3&mode=edit', null],
] as const)
  test(`a ${name} editor refused by its room stays on the page, read-only`, async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    if (text)
      await expect(page.getByText(text).first()).toBeVisible({
        timeout: 60_000,
      });
    // Each joins its room on its own time after it paints.
    await expect
      .poll(() => refuseRooms(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(page.getByText(m.editor_access_lost())).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(m.editor_access_lost_body())).toHaveCount(0);
    await expect(page.getByText(m.files_missing_title())).toHaveCount(0);
    await expect(page.getByText(m.error_file_title())).toHaveCount(0);
    if (text) await expect(page.getByText(text).first()).toBeVisible();
  });
