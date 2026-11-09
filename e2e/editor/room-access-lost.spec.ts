import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

// Epo 2026-11-05: a room refusing someone leaves the page as it is: an editor
// goes read-only under a strip saying so. Only a refused read ends what shows.
const refuseRooms = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseOpenRooms } = await import(path);
    return refuseOpenRooms() as number;
  });

const lowerRooms = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { announceReadOnly } = await import(path);
    return announceReadOnly() as number;
  });

const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');

async function expectStrip(page: Page) {
  await expect(page.getByText(m.editor_access_lost())).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(m.error_not_found_title())).toHaveCount(0);
  await expect(page.getByText(m.error_file_title())).toHaveCount(0);
}

const SCENARIOS = '/workspaces/ws_scenarios?material=';
const QUIZ = '/workspaces/ws_bio?material=qz_bio_near';
const CARDS = `${SCENARIOS}mock-scenario-cards`;
const DIAGRAM = '/workspaces/ws_bio?material=mat_2';

for (const [name, url, text] of [
  [
    'note',
    '/workspaces/ws_bio?material=mat_note_1',
    'Prokaryotes vs eukaryotes',
  ],
  ['quiz', QUIZ, null],
  ['flashcard set', CARDS, 'Scenario flashcards'],
  ['diagram', DIAGRAM, null],
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
    await expectStrip(page);
    if (text) await expect(page.getByText(text).first()).toBeVisible();
  });

// A note this device keeps a copy of reads without its body, so dropping to the
// reader's path would ask for a read the room's refusal says will fail.
test('a note editor with a device copy keeps what it holds when refused', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = 'A note for trying application errors.';
  await page.goto(`${SCENARIOS}mock-scenario-note`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await clickTextEnd(editable(page).getByText(seed));
  await page.keyboard.type(' kept');
  const status = page.getByTestId('editor-save-state');
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await page.reload();
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await clickTextEnd(editable(page).getByText(`${seed} kept`));
  await page.keyboard.type(' more');
  await expect(status).toHaveAttribute('data-save-state', 'saved');

  await expect
    .poll(() => refuseRooms(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expectStrip(page);
  await expect(page.getByText(`${seed} kept more`)).toBeVisible();
  await expect(editable(page)).toHaveCount(0);
  await expect(status).toHaveCount(0);
});

// Epo 2026-11-05 (Q644): refused with no "your access changed" first, it may be
// gone, so the page asks for its read; refused too, it says only that it is
// unavailable.
for (const [name, url, rows, id] of [
  ['note', '/workspaces/ws_bio?material=mat_note_1', 'materials', 'mat_note_1'],
  ['quiz', QUIZ, 'materials', 'qz_bio_near'],
  ['text file', '/workspaces/ws_bio?file=f_3&mode=edit', 'files', 'f_3'],
] as const)
  test(`a ${name} refused by its room and by its read says it is unavailable`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    const shown = page.getByText(m.error_not_found_title());
    await expect(async () => {
      await page.evaluate(
        async ({ rows, id }) => {
          const paths = ['/src/mocks/db.ts', '/src/mocks/collaboration.ts'];
          const [db, { refuseOpenRooms }] = await Promise.all(
            paths.map((path) => import(path))
          );
          const at = db[rows].findIndex((row: { id: string }) => row.id === id);
          if (at >= 0) db[rows].splice(at, 1);
          refuseOpenRooms();
        },
        { id, rows }
      );
      await expect(shown).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  });

for (const [name, url] of [
  ['quiz', QUIZ],
  ['flashcard set', CARDS],
  ['diagram', DIAGRAM],
] as const)
  test(`a ${name} editor lowered to a reader is told so`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => lowerRooms(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(page.getByText(m.editor_read_only_strip())).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  });
