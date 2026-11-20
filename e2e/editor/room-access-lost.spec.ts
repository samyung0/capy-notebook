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

/** The lost-access toast (Epo 2026-11-20), apart from the strip. */
const kickedToast = (page: Page) =>
  page.getByRole('alert').filter({ hasText: m.editor_access_lost() });

type ReadKey = readonly [string, string];

/** When the page's read of an item last settled (answered or refused), or 0
 * while one is under way. */
const readSettled = (page: Page, key: ReadKey) =>
  page.evaluate(async (queryKey) => {
    const path = '/src/api/queryClient.ts';
    const { queryClient } = await import(path);
    const state = queryClient.getQueryState(queryKey);
    return state?.fetchStatus === 'idle'
      ? Math.max(state.dataUpdatedAt, state.errorUpdatedAt)
      : 0;
  }, key);

/** The access-lost strip over the page, once the read the refusal asked for
 * (`before`: when it last settled) answered: no toast. */
async function expectStrip(page: Page, key: ReadKey, before: number) {
  await expect(page.getByText(m.editor_access_lost())).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => readSettled(page, key), { timeout: 15_000 })
    .toBeGreaterThan(before);
  await expect(page.getByText(m.error_not_found_title())).toHaveCount(0);
  await expect(page.getByText(m.error_file_title())).toHaveCount(0);
  await expect(kickedToast(page)).toHaveCount(0);
}

// Set to a folder to keep a screenshot of the unavailable page with the
// toast and the Files panel without the item.
const shots = process.env.ACCESS_LOST_SCREENSHOTS;

const SCENARIOS = '/workspaces/ws_scenarios?material=';
const QUIZ = '/workspaces/ws_bio?material=qz_bio_near';
const CARDS = `${SCENARIOS}mock-scenario-cards`;
const DIAGRAM = '/workspaces/ws_bio?material=mat_2';

for (const [name, url, text, read] of [
  [
    'note',
    '/workspaces/ws_bio?material=mat_note_1',
    'Prokaryotes vs eukaryotes',
    ['material', 'mat_note_1'],
  ],
  ['quiz', QUIZ, null, ['material', 'qz_bio_near']],
  [
    'flashcard set',
    CARDS,
    'Scenario flashcards',
    ['material', 'mock-scenario-cards'],
  ],
  ['diagram', DIAGRAM, null, ['material', 'mat_2']],
  ['text file', '/workspaces/ws_bio?file=f_3&mode=edit', null, ['file', 'f_3']],
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
    await expect.poll(() => readSettled(page, read)).toBeGreaterThan(0);
    const before = await readSettled(page, read);
    // Each joins its room on its own time after it paints.
    await expect
      .poll(() => refuseRooms(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expectStrip(page, read, before);
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

  const read = ['material', 'mock-scenario-note'] as const;
  const before = await readSettled(page, read);
  await expect
    .poll(() => refuseRooms(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expectStrip(page, read, before);
  await expect(page.getByText(`${seed} kept more`)).toBeVisible();
  await expect(editable(page)).toHaveCount(0);
  await expect(status).toHaveCount(0);
});

// Epo 2026-11-20 ("the page should itself refetch and show the 404 error"):
// a room's refusal asks for the page's read, an access change (4403)
// included; refused too, the page says it is unavailable, with a toast saying
// they lost access, once, and the item leaves the Files panel, whose lists
// read again.
const NOTE_URL = '/workspaces/ws_bio?material=mat_note_1';
for (const [name, url, rows, id, close] of [
  ['note', NOTE_URL, 'materials', 'mat_note_1', 'refuseOpenRooms'],
  [
    'note closed for an access change (4403)',
    NOTE_URL,
    'materials',
    'mat_note_1',
    'closeOpenNotesForAccess',
  ],
  ['quiz', QUIZ, 'materials', 'qz_bio_near', 'refuseOpenRooms'],
  [
    'text file',
    '/workspaces/ws_bio?file=f_3&mode=edit',
    'files',
    'f_3',
    'refuseOpenRooms',
  ],
] as const)
  test(`a ${name} refused by its room and by its read says it is unavailable`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    const listed = page.locator(
      `[data-workspace-file-tree] a[href*="${rows === 'files' ? 'file' : 'material'}=${id}"]`
    );
    await expect(listed.first()).toBeVisible({ timeout: 60_000 });
    // Its room joined: the toast is for an open editor's refusal alone.
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    const shown = page.getByText(m.error_not_found_title());
    await expect(async () => {
      await page.evaluate(
        async ({ close, rows, id }) => {
          const paths = ['/src/mocks/db.ts', '/src/mocks/collaboration.ts'];
          const [db, rooms] = await Promise.all(
            paths.map((path) => import(path))
          );
          const at = db[rows].findIndex((row: { id: string }) => row.id === id);
          if (at >= 0) db[rows].splice(at, 1);
          rooms[close]();
        },
        { close, id, rows }
      );
      await expect(shown).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(kickedToast(page)).toBeVisible();
    // Once: one toast, never counted up.
    await expect(kickedToast(page)).toHaveCount(1);
    await expect(page.locator('.tst-count')).toHaveCount(0);
    // No strip: only the toast says it.
    await expect(
      page.getByRole('status').filter({ hasText: m.editor_access_lost() })
    ).toHaveCount(0);
    await expect(listed).toHaveCount(0, { timeout: 15_000 });
    if (shots && close === 'closeOpenNotesForAccess')
      await page.screenshot({ path: `${shots}/kicked-4403.png` });
    else if (shots && name === 'note')
      await page.screenshot({ path: `${shots}/kicked-unavailable.png` });
  });

// An item simply opened unavailable (its room never joined) says so as any
// refusal, with no toast: the person lost nothing they had open.
test('an item opened unavailable says so with no lost-access toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(NOTE_URL);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  const quiz = page.locator(
    '[data-workspace-file-tree] a[href*="material=qz_bio_near"]'
  );
  await expect(quiz.first()).toBeVisible({ timeout: 60_000 });
  // Gone from the API while the panel still lists it.
  await page.evaluate(async () => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const at = db.materials.findIndex(
      (row: { id: string }) => row.id === 'qz_bio_near'
    );
    db.materials.splice(at, 1);
  });
  await quiz.first().click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => readSettled(page, ['material', 'qz_bio_near']))
    .toBeGreaterThan(0);
  await expect(kickedToast(page)).toHaveCount(0);
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
