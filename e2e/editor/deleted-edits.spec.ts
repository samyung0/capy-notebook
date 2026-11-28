import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { skipWhileFilesViewOnly } from '../helpers/filesViewOnly';
import { officeEditMenu, officeFrame } from '../helpers/office';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

/**
 * Unsent edits to an item that was deleted (Epo 2026-11-19 and 2026-11-20,
 * Q39-Q44): the API answers `item_deleted` to whoever could read it, and the
 * edits are offered, on the open page read-only under the deleted strip, on
 * any other page by a toast with Discard and Download; edits to an item
 * whose access went go silently. The scenario fixtures keep their drafts
 * across reloads (editDrafts.ts), and the mocks keep who deleted what
 * (`deleteMockItem`, `loseMockAccess`).
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Canvases = typeof import('../../src/mocks/canvas');

// Set to a folder to keep a screenshot of the toast and the strip, at the
// desktop width and at the narrowest phone's.
const shots = process.env.DELETED_SCREENSHOTS;
async function shot(page: Page, name: string) {
  if (!shots) return;
  const size = page.viewportSize();
  // Past the toast's entrance.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.setViewportSize({ height: 740, width: 360 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/${name}-360.png` });
  if (size) await page.setViewportSize(size);
}

const WORKSPACE = '/workspaces/ws_scenarios';
const NOTE = 'mock-scenario-note';
const SEED = 'A note for trying application errors.';
const editor = (page: Page) =>
  page.locator('[data-slate-editor="true"]').first();

/** The seed text in the note's live editor, once it shows: the paint it took
 * over from stays in the DOM, hidden, until the browser is idle (NoteBody's
 * PaintedFrame), and the first Slate root may be that paint's. */
async function seedText(page: Page) {
  const text = page
    .locator('[data-slate-editor="true"][contenteditable="true"]')
    .getByText(SEED);
  await expect(text).toBeVisible();
  return text;
}

/** The SPA goes to `url`, the page and its modules staying. */
const navigate = (page: Page, url: string) =>
  page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);

/** The collaboration mock as a server that is down (kept across reloads). */
const setReachable = (page: Page, reachable: boolean) =>
  page.evaluate(async (value) => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = (await import(path)) as Collaboration;
    setCollaborationReachable(value);
  }, reachable);

/** Deletes an item as another person does, or (`payer`) as its creator does
 * in another tab: the trash fallback then reads them the trashed item.
 * `queued`: its rooms' eviction still queued (`deleteMockItem`). */
const deleteItem = (
  page: Page,
  id: string,
  kind: string,
  name: string,
  payer = false,
  queued = false
) =>
  page.evaluate(
    async ([itemId, item, later]) => {
      const path = '/src/mocks/collaboration.ts';
      const { deleteMockItem } = (await import(path)) as Collaboration;
      deleteMockItem(itemId, item, later);
    },
    [id, { kind, name, payer }, queued] as const
  );

/** Restores a deleted material (`restoreMockItem`) and reads it again. */
const restoreItem = (page: Page, id: string) =>
  page.evaluate(async (itemId) => {
    const paths = ['/src/mocks/collaboration.ts', '/src/api/queryClient.ts'];
    const [rooms, { queryClient }] = await Promise.all(
      paths.map((path) => import(path))
    );
    (rooms as Collaboration).restoreMockItem(itemId);
    await queryClient.invalidateQueries({ queryKey: ['material', itemId] });
  }, id);

const loseAccess = (page: Page, id: string) =>
  page.evaluate(async (itemId) => {
    const path = '/src/mocks/collaboration.ts';
    const { loseMockAccess } = (await import(path)) as Collaboration;
    loseMockAccess(itemId);
  }, id);

/** How many rows this device stores for a material, or a file. */
const storedRows = (page: Page, id: string, kind = 'material') =>
  page.evaluate(
    async ([itemId, itemKind]) => {
      const draftsPath = '/src/lib/editDrafts.ts';
      const dbPath = '/src/mocks/db.ts';
      const [{ draftKey, readDrafts }, { user }] = await Promise.all([
        import(draftsPath),
        import(dbPath),
      ]);
      return ((await readDrafts(draftKey(user.id, itemKind, itemId))) as [])
        .length;
    },
    [id, kind] as const
  );

/** The kinds of a material's stored rows. */
const storedKinds = (page: Page, id: string) =>
  page.evaluate(async (materialId) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const [{ draftKey, readDrafts }, { user }] = await Promise.all([
      import(draftsPath),
      import(dbPath),
    ]);
    return (
      (await readDrafts(draftKey(user.id, 'material', materialId))) as {
        kind: string;
      }[]
    ).map((row) => row.kind);
  }, id);

/** Opens the scenario note at `url` (its workspace's page by default), an
 * image after its intro (the room is seeded from the read), and types `text`
 * at its intro's end with the collaboration service down, so the edits stay
 * on this device. */
async function typeOffline(
  page: Page,
  text: string,
  url = `${WORKSPACE}?material=${NOTE}`
) {
  await page.goto(WORKSPACE);
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.evaluate(async (id) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const note = db.materials.find((row: { id: string }) => row.id === id);
    note.content.value.push({
      assetId: 'mock-missing-image',
      children: [{ text: '' }],
      id: 'mock-scenario-image',
      type: 'img',
    });
  }, NOTE);
  await navigate(page, url);
  await expect(editor(page)).toContainText(SEED, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  const seed = await seedText(page);
  await setReachable(page, false);
  await clickTextEnd(seed);
  await page.keyboard.type(text);
  await expect.poll(() => storedRows(page, NOTE)).toBeGreaterThan(0);
}

/** A deleted note's toast at the next page load, on another page. */
async function deletedNoteToast(page: Page) {
  await typeOffline(page, ' Offline edit.');
  await deleteItem(page, NOTE, 'note', 'Scenario note');
  await navigate(page, WORKSPACE);
  await expect(editor(page)).toHaveCount(0);
  await page.reload();
  return toast(page, 'Scenario note');
}

const toast = (page: Page, title: string) =>
  page
    .getByRole('alert')
    .filter({ hasText: m.lost_edits_title({ title }) })
    .filter({ hasText: m.lost_edits_body() });

test("a deleted note's unsent edits are offered on another page: × keeps them for the next load, Discard ends them", async ({
  page,
}) => {
  test.slow();
  const offer = await deletedNoteToast(page);
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await shot(page, 'toast');
  await offer.getByRole('button', { name: m.action_close() }).click();
  await expect(offer).toHaveCount(0);
  expect(await storedRows(page, NOTE)).toBeGreaterThan(0);

  await page.reload();
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await offer.getByRole('button', { name: m.action_discard() }).click();
  await expect(offer).toHaveCount(0);
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
  await page.reload();
  await expect(page.getByText('User scenarios').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(3000);
  await expect(offer).toHaveCount(0);
});

test("a deleted note's Download saves its edits as Markdown, an image as a line saying it is not included, and ends them", async ({
  page,
}) => {
  test.slow();
  const offer = await deletedNoteToast(page);
  await expect(offer).toBeVisible({ timeout: 30_000 });
  const saving = page.waitForEvent('download');
  await offer.getByRole('button', { name: m.action_download() }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(
    `Scenario note (${m.lost_edits_file()}).md`
  );
  const text = await readFile(await file.path(), 'utf8');
  expect(text).toContain(`${SEED} Offline edit.`);
  expect(text).toContain(m.lost_edits_image());
  await expect(offer).toHaveCount(0);
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
});

test('a note deleted by another person while open keeps its unsent edits on screen under the deleted strip, and Discard ends them', async ({
  page,
}) => {
  test.slow();
  await typeOffline(page, ' Kept to copy.');
  await deleteItem(page, NOTE, 'note', 'Scenario note');
  // Back online: the rejoin's token says the note was deleted.
  await setReachable(page, true);
  const strip = page.getByText(m.editor_deleted_strip());
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`${SEED} Kept to copy.`)).toBeVisible();
  await shot(page, 'strip');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toHaveCount(0);
  await expect(toast(page, 'Scenario note')).toHaveCount(0);

  // Epo 2026-11-21: Discard (ghost-hover), then the dark Download.
  const actions = page.getByTestId('save-banner').getByRole('button');
  await expect(actions).toHaveText([m.action_discard(), m.action_download()]);
  await expect(actions.first()).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(actions.last()).toHaveAttribute('data-variant', 'dark');
  await actions.first().click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
  await expect(toast(page, 'Scenario note')).toHaveCount(0);
});

/** The text of a saved .docx. */
async function docxText(path: string) {
  const zip = unzipSync(new Uint8Array(await readFile(path)));
  return strFromU8(zip['word/document.xml']).replace(/<[^>]+>/g, '');
}

// Epo 2026-11-20: the deleted strip downloads what shows after its Discard, as
// the toast's file, and the header's ⋮ keeps Properties and the page's own
// downloads (a note's Markdown and Word); none of them deletes anything.
test('a note deleted while open downloads what shows from its strip and its ⋮, and keeps Properties', async ({
  page,
}) => {
  test.slow();
  await typeOffline(page, ' Kept to copy.');
  await deleteItem(page, NOTE, 'note', 'Scenario note');
  await setReachable(page, true);
  const strip = page.getByTestId('save-banner');
  await expect(strip).toHaveAttribute('data-kind', 'deleted', {
    timeout: 30_000,
  });
  await expect(page.getByText(`${SEED} Kept to copy.`)).toBeVisible();
  await shot(page, 'strip-download');

  const markdown = page.waitForEvent('download');
  await strip.getByRole('button', { name: m.action_download() }).click();
  const md = await markdown;
  expect(md.suggestedFilename()).toBe(
    `Scenario note (${m.lost_edits_file()}).md`
  );
  expect(await readFile(await md.path(), 'utf8')).toContain(
    `${SEED} Kept to copy.`
  );
  await expect(strip).toHaveAttribute('data-kind', 'deleted');
  expect(await storedRows(page, NOTE)).toBeGreaterThan(0);

  const menu = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.a11y_open_menu() });
  await menu.click();
  const word = page.getByRole('menuitem', { name: m.action_download_docx() });
  await expect(word).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: m.action_download_markdown() })
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: m.content_properties() })
  ).toBeVisible();
  for (const gone of [m.action_rename(), m.action_delete()])
    await expect(page.getByRole('menuitem', { name: gone })).toHaveCount(0);
  if (shots) {
    // Past the menu's entrance.
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/menu.png` });
  }
  const saving = page.waitForEvent('download');
  await word.click();
  const docx = await saving;
  expect(docx.suggestedFilename()).toBe(
    `Scenario note (${m.lost_edits_file()}).docx`
  );
  expect(await docxText(await docx.path())).toContain('Kept to copy.');

  await menu.click();
  await page.getByRole('menuitem', { name: m.content_properties() }).click();
  const properties = page.getByRole('dialog').filter({
    hasText: m.content_properties_title({ kind: m.common_material() }),
  });
  await expect(properties).toBeVisible();
  await expect(properties).toContainText('Scenario note');
  expect(await storedRows(page, NOTE)).toBeGreaterThan(0);
});

// Review 2026-11-20 (2): online, unacknowledged typing is update rows only,
// which no drawing places without the room; the discard's notice writes the
// whole document first, so the page's read, which says deleted before the
// rejoin's token does, finds it.
test('a note deleted while its editor is online keeps its unacknowledged typing under the deleted strip', async ({
  page,
}) => {
  test.slow();
  await page.goto(`${WORKSPACE}?material=${NOTE}`);
  await expect(editor(page)).toContainText(SEED, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteReceipts } = (await import(path)) as Collaboration;
    holdNoteReceipts(id, true);
  }, NOTE);
  await clickTextEnd(await seedText(page));
  await page.keyboard.type(' Typed online.');
  await expect.poll(() => storedKinds(page, NOTE)).toContain('update');
  expect(await storedKinds(page, NOTE)).not.toContain('state');
  await deleteItem(page, NOTE, 'note', 'Scenario note');
  await expect(page.getByText(m.editor_deleted_strip())).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`${SEED} Typed online.`)).toBeVisible();

  await page
    .getByTestId('save-banner')
    .getByRole('button', { name: m.action_discard() })
    .click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
});

test('a note deleted by another person while open with nothing unsent says it is unavailable', async ({
  page,
}) => {
  await page.goto(`${WORKSPACE}?material=${NOTE}`);
  await expect(editor(page)).toContainText(SEED, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await deleteItem(page, NOTE, 'note', 'Scenario note');
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(m.editor_deleted_strip())).toHaveCount(0);
  // Deleted, not kicked: no lost-access toast (Epo 2026-11-20).
  await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
});

// Review 2026-11-20: a trashed read has every right off; that is no demotion,
// so the note restored edits again, with no read-only strip.
test('a note its creator trashed elsewhere and restored while open edits again', async ({
  page,
}) => {
  await page.goto(`${WORKSPACE}?material=${NOTE}`);
  await expect(editor(page)).toContainText(SEED, { timeout: 30_000 });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  await deleteItem(page, NOTE, 'note', 'Scenario note', true);
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });

  await restoreItem(page, NOTE);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await expect(page.getByText(m.editor_read_only_strip())).toHaveCount(0);
  // Deleted, never kicked: no lost-access strip once restored either.
  await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  // Its live editor, writable.
  await seedText(page);
});

/** Holds the page's read of a material until `releaseRead`, then lets the
 * mocks answer it, as a read slower than the room's token is. */
const holdRead = (page: Page, id: string) =>
  page.evaluate(async (itemId) => {
    const path = '/src/mocks/browser.ts';
    const { http, worker } = await import(path);
    const released = new Promise((resolve) =>
      window.addEventListener('read-release', resolve, { once: true })
    );
    worker.use(
      http.get(`/api/materials/${itemId}`, async () => {
        await released;
      })
    );
  }, id);
const releaseRead = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('read-release')));

/** A material's content as the mocks store it from its room's checkpoints. */
const storedContent = (page: Page, id: string) =>
  page.evaluate(async (materialId) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const material = db.materials.find(
      (row: { id: string }) => row.id === materialId
    );
    return JSON.stringify(material?.content ?? null);
  }, id);

// A note's, a set's or a diagram's room hears of the deletion (its rejoin's
// or fresh room's token, 410) before the page's read does: it says
// unavailable, never that access went (Epo 2026-11-20), and restored and read
// again it edits on a fresh room.
for (const [name, url, id, kind, title] of [
  ['note', `${WORKSPACE}?material=${NOTE}`, NOTE, 'note', 'Scenario note'],
  [
    'flashcard set',
    '/workspaces/ws_scenarios?material=mock-scenario-cards',
    'mock-scenario-cards',
    'flashcards',
    'Scenario flashcards',
  ],
  [
    'diagram',
    '/workspaces/ws_bio?material=mat_2',
    'mat_2',
    'diagram',
    'Protein secretion pathway',
  ],
] as const)
  test(`a ${name} deleted while open with nothing unsent says it is unavailable, and edits again once restored`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(url);
    const saveState = page.getByTestId('editor-save-state');
    await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
      timeout: 60_000,
    });
    await holdRead(page, id);
    await deleteItem(page, id, kind, title);
    // Its room said so (no save status), the read still out.
    await expect(saveState).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
    await releaseRead(page);
    await expect(page.getByText(m.error_not_found_title())).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);

    await restoreItem(page, id);
    await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
      timeout: 30_000,
    });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
    await expect(page.getByText(m.editor_read_only_strip())).toHaveCount(0);
    // An edit lands, stored through the fresh room.
    const edit = {
      diagram: '%% restored',
      flashcards: 'Restored card',
      note: 'Restored note.',
    }[kind];
    if (kind === 'note') {
      await clickTextEnd(await seedText(page));
      await page.keyboard.type(` ${edit}`);
    } else if (kind === 'flashcards') {
      await page
        .getByRole('button', { exact: true, name: m.flashcards_add_card() })
        .first()
        .click();
      const dialog = page.getByRole('dialog', {
        name: m.flashcards_edit_card(),
      });
      await dialog
        .getByRole('textbox', { name: m.editor_card_front() })
        .fill(edit);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } else {
      await page
        .getByRole('textbox', { name: m.editor_mermaid_source() })
        .click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(`\n${edit}`);
    }
    await expect
      .poll(() => storedContent(page, id), { timeout: 30_000 })
      .toContain(edit);
    await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  });

// Review 2026-11-20: the creator trashing their own note in another tab is
// read the trashed note (the trash fallback), and this page says deleted, not
// the Trash's strip.
test('a note its creator trashed in another tab keeps its unsent edits under the deleted strip, not the Trash strip', async ({
  page,
}) => {
  test.slow();
  await typeOffline(page, ' Kept to copy.');
  await deleteItem(page, NOTE, 'note', 'Scenario note', true);
  await setReachable(page, true);
  await expect(page.getByText(m.editor_deleted_strip())).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`${SEED} Kept to copy.`)).toBeVisible();
  await expect(
    page.getByRole('button', { name: m.trash_restore() })
  ).toHaveCount(0);

  await page
    .getByTestId('save-banner')
    .getByRole('button', { name: m.action_discard() })
    .click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
});

// Review 2026-11-20: the note's own page (/materials/:id) keeps it mounted
// when it is deleted while shown, answered `item_deleted` or, to its creator,
// read trashed.
for (const payer of [false, true])
  test(`a note deleted while open on its own page keeps its unsent edits under the deleted strip (${payer ? 'its creator' : 'another person'} deleted it)`, async ({
    page,
  }) => {
    test.slow();
    await typeOffline(page, ' Kept to copy.', `/materials/${NOTE}`);
    await deleteItem(page, NOTE, 'note', 'Scenario note', payer);
    await setReachable(page, true);
    await expect(page.getByText(m.editor_deleted_strip())).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(`${SEED} Kept to copy.`)).toBeVisible();
    await expect(
      page.getByRole('button', { name: m.trash_restore() })
    ).toHaveCount(0);

    const loaded = page.waitForEvent('load', { timeout: 60_000 });
    await page
      .getByTestId('save-banner')
      .getByRole('button', { name: m.action_discard() })
      .click();
    await loaded;
    await expect.poll(() => storedRows(page, NOTE)).toBe(0);
  });

test('the unsent edits of a note this person lost go silently at the next page load', async ({
  page,
}) => {
  test.slow();
  await typeOffline(page, ' Lost edit.');
  await loseAccess(page, NOTE);
  await navigate(page, WORKSPACE);
  await expect(editor(page)).toHaveCount(0);
  await page.reload();
  await expect.poll(() => storedRows(page, NOTE), { timeout: 30_000 }).toBe(0);
  await expect(page.getByText(m.lost_edits_body())).toHaveCount(0);
});

/** The scenarios workspace's first canvas keeps drafts under the mocks. */
const CANVAS = 'mock-scenario-canvas-1';

test("a deleted canvas's Download saves its unsent strokes as a PNG", async ({
  page,
}) => {
  test.slow();
  await page.goto(`${WORKSPACE}?view=canvas`);
  await page.waitForFunction(() => (window as { __board?: unknown }).__board);
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  // The tab's socket down: the stroke stays on this device.
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { mockBoardSocket } = (await import(path)) as Collaboration;
    mockBoardSocket(id, false);
  }, CANVAS);
  await page.locator('edgeless-pen-tool-button').first().click();
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(
      box.x + box.width * (0.4 + step * 0.02),
      box.y + box.height * (0.4 + step * 0.01)
    );
  await page.mouse.up();
  await expect.poll(() => storedRows(page, CANVAS)).toBeGreaterThan(0);
  // The board's own Download as image, for the size the file should have.
  const size = await page.evaluate(async () => {
    const { __board } = window as {
      __board?: { image: () => Promise<Blob> };
    };
    if (!__board) throw new Error('no board');
    const bitmap = await createImageBitmap(await __board.image());
    return [bitmap.width, bitmap.height];
  });
  await deleteItem(page, CANVAS, 'canvas', 'Lab board');
  await navigate(page, WORKSPACE);
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await page.reload();

  const offer = toast(page, 'Lab board');
  await expect(offer).toBeVisible({ timeout: 30_000 });
  const saving = page.waitForEvent('download');
  await offer.getByRole('button', { name: m.action_download() }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(
    `Lab board (${m.lost_edits_file()}).png`
  );
  const bytes = await readFile(await file.path());
  const decoded = await page.evaluate(async (base64) => {
    const png = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([png], { type: 'image/png' })
    );
    return [bitmap.width, bitmap.height];
  }, bytes.toString('base64'));
  expect(decoded).toEqual(size);
  await expect.poll(() => storedRows(page, CANVAS)).toBe(0);
});

// Epo 2026-11-20: a canvas deleted while open keeps its unsent strokes on
// the board under the deleted strip, whose Download saves them as its board's
// image, as the toast's does, and deletes nothing. Epo 2026-11-21: its
// Discard asks first, the confirm reading Discard.
test('a canvas deleted while open downloads its unsent strokes from its strip and keeps them, and Discard ends them after asking', async ({
  page,
}) => {
  test.slow();
  await page.goto(`${WORKSPACE}?view=canvas`);
  await page.waitForFunction(() => (window as { __board?: unknown }).__board);
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  const socket = (up: boolean) =>
    page.evaluate(
      async ([id, back]) => {
        const path = '/src/mocks/collaboration.ts';
        const { mockBoardSocket } = (await import(path)) as Collaboration;
        mockBoardSocket(id, back);
      },
      [CANVAS, up] as const
    );
  // The tab's socket down: the stroke stays on this device.
  await socket(false);
  await page.locator('edgeless-pen-tool-button').first().click();
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(
      box.x + box.width * (0.4 + step * 0.02),
      box.y + box.height * (0.4 + step * 0.01)
    );
  await page.mouse.up();
  await expect.poll(() => storedRows(page, CANVAS)).toBeGreaterThan(0);
  await deleteItem(page, CANVAS, 'canvas', 'Lab board');
  await socket(true);

  const strip = page.locator('[data-canvas-strip]');
  await expect(strip).toContainText(m.editor_deleted_strip(), {
    timeout: 30_000,
  });
  await shot(page, 'canvas-strip-download');
  const saving = page.waitForEvent('download');
  await strip.getByRole('button', { name: m.action_download() }).click();
  const file = await saving;
  // Named as the page names the canvas.
  expect(file.suggestedFilename()).toBe(
    `User scenarios (${m.lost_edits_file()}).png`
  );
  await expect(strip).toContainText(m.editor_deleted_strip());
  expect(await storedRows(page, CANVAS)).toBeGreaterThan(0);

  const actions = strip.getByRole('button');
  await expect(actions).toHaveText([m.action_discard(), m.action_download()]);
  await expect(actions.first()).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(actions.last()).toHaveAttribute('data-variant', 'dark');
  await actions.first().click();
  const loaded = page.waitForEvent('load', { timeout: 60_000 });
  await page
    .getByRole('dialog', { name: m.canvas_reload_discard_title() })
    .getByRole('button', { name: m.action_discard() })
    .click();
  await loaded;
  await expect.poll(() => storedRows(page, CANVAS)).toBe(0);
});

// Review 2026-11-20 (1): a member's shared canvas its maker deletes while it
// is open is deleted to them too, whichever of its list (the tree event) and
// its room tells them first: its read answers `item_deleted`, so the board
// stays with its unsent strokes under the deleted strip, and no toast says
// they lost access.
for (const first of ['list', 'room'] as const)
  test(`a member's canvas its maker deletes while open shows the deleted strip, with no access-lost toast (${first} first)`, async ({
    page,
  }) => {
    test.slow();
    await page.goto(`${WORKSPACE}?view=canvas`);
    await page.waitForFunction(() => (window as { __board?: unknown }).__board);
    await page.addStyleTag({
      content: '[data-testid="mock-scenario-panel"] { display: none; }',
    });
    const theirs = await page.evaluate(async () => {
      const path = '/src/mocks/canvas.ts';
      const { mockMemberCanvas } = (await import(path)) as Canvases;
      return mockMemberCanvas({
        creatorName: 'Ben',
        role: 'editor',
        title: 'Lab diagrams',
        workspaceId: 'ws_scenarios',
      });
    });
    await navigate(page, `${WORKSPACE}?view=canvas&c=${theirs}`);
    await expect(
      page
        .locator('[data-workspace-canvas]')
        .getByRole('button', { exact: true, name: 'Lab diagrams' })
    ).toBeVisible();
    await expect(
      page.locator('.capy-board-status [role=status]')
    ).toHaveAttribute('data-save-state', 'saved');
    const socket = (up: boolean) =>
      page.evaluate(
        async ([id, back]) => {
          const path = '/src/mocks/collaboration.ts';
          const { mockBoardSocket } = (await import(path)) as Collaboration;
          mockBoardSocket(id, back);
        },
        [theirs, up] as const
      );
    const relist = () =>
      page.evaluate(async () => {
        const path = '/src/api/queryClient.ts';
        const { queryClient } = await import(path);
        await queryClient.invalidateQueries({ queryKey: ['canvases'] });
      });
    // The tab's socket down: the stroke stays on this device.
    await socket(false);
    await page.locator('edgeless-pen-tool-button').first().click();
    const box = await page.locator('affine-edgeless-root').boundingBox();
    if (!box) throw new Error('no board');
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++)
      await page.mouse.move(
        box.x + box.width * (0.4 + step * 0.02),
        box.y + box.height * (0.4 + step * 0.01)
      );
    await page.mouse.up();
    await expect.poll(() => storedRows(page, theirs)).toBeGreaterThan(0);

    // Ben trashes it: gone from the lists, its room and read deleted.
    await page.evaluate(async (id) => {
      const paths = ['/src/mocks/canvas.ts', '/src/mocks/collaboration.ts'];
      const [canvases, collaboration] = (await Promise.all(
        paths.map((path) => import(path))
      )) as [Canvases, Collaboration];
      canvases.trashMockMemberCanvas(id);
      collaboration.deleteMockItem(id, {
        kind: 'canvas',
        name: 'Lab diagrams',
      });
    }, theirs);
    if (first === 'list') await relist();
    await socket(true);
    if (first === 'room') {
      await expect(page.locator('[data-canvas-strip]')).toContainText(
        m.editor_deleted_strip(),
        { timeout: 30_000 }
      );
      await relist();
    }

    const strip = page.locator('[data-canvas-strip]');
    await expect(strip).toContainText(m.editor_deleted_strip(), {
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);
    await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
    await expect(strip).toContainText(m.editor_deleted_strip());
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
    const saving = page.waitForEvent('download');
    await strip.getByRole('button', { name: m.action_download() }).click();
    expect((await saving).suggestedFilename()).toBe(
      `Lab diagrams (${m.lost_edits_file()}).png`
    );
  });

const DOCX = 'mock-scenario-docx';
const DOCX_NAME = 'Scenario document.docx';

/** The browser offline, as the Office tests take it (the mock room does not
 * read the collaboration mock's reachability). */
async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

/** Opens the scenario DOCX for editing and types `text` at its end offline,
 * so the edits stay on this device. */
async function typeDocxOffline(page: Page, text: string) {
  await page.goto(`${WORKSPACE}?file=${DOCX}&mode=edit`);
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  await setOnline(page, false);
  const input = officeFrame(page).getByLabel('Document input');
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.pressSequentially(text);
  await expect.poll(() => storedRows(page, DOCX, 'file')).toBeGreaterThan(0);
}

// Review 2026-11-20: an Office file deleted while open keeps its edits under
// the deleted strip, its View/Edit control off (both need the file).
test('a DOCX deleted while open keeps its unsent edits under the deleted strip, and Discard ends them', async ({
  page,
}) => {
  skipWhileFilesViewOnly();
  test.setTimeout(240_000);
  await typeDocxOffline(page, ' Kept to copy.');
  await deleteItem(page, DOCX, 'doc', DOCX_NAME);
  await setOnline(page, true);
  const strip = officeFrame(page).getByTestId('save-banner');
  await expect(strip).toHaveAttribute('data-kind', 'deleted', {
    timeout: 60_000,
  });
  await expect(strip).toContainText(m.editor_deleted_strip());
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toBeDisabled();
  await expect(toast(page, DOCX_NAME)).toHaveCount(0);

  // The frame draws Discard (ghost-hover), then the dark Download, neither
  // underlined (Epo 2026-11-21): its own CSS, office-runtime.css.
  const actions = strip.getByRole('button');
  await expect(actions).toHaveText([m.action_discard(), m.action_download()]);
  await expect(actions.first()).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(actions.last()).toHaveAttribute('data-variant', 'dark');
  for (const action of [actions.first(), actions.last()])
    await expect(action).toHaveCSS('text-decoration-line', 'none');
  await expect(actions.last()).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  const loaded = page.waitForEvent('load', { timeout: 60_000 });
  await actions.first().click();
  await loaded;
  await expect.poll(() => storedRows(page, DOCX, 'file')).toBe(0);
});

// Epo 2026-11-20: the strip's Download in the frame saves the toast's .docx
// and deletes nothing.
test('a DOCX deleted while open downloads its unsent edits from its strip and keeps them', async ({
  page,
}) => {
  skipWhileFilesViewOnly();
  test.setTimeout(240_000);
  await typeDocxOffline(page, ' Kept to copy.');
  await deleteItem(page, DOCX, 'doc', DOCX_NAME);
  await setOnline(page, true);
  const strip = officeFrame(page).getByTestId('save-banner');
  await expect(strip).toHaveAttribute('data-kind', 'deleted', {
    timeout: 60_000,
  });
  const saving = page.waitForEvent('download');
  await strip.getByRole('button', { name: m.action_download() }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(
    `Scenario document (${m.lost_edits_file()}).docx`
  );
  expect(await docxText(await file.path())).toContain('Kept to copy.');
  await expect(strip).toHaveAttribute('data-kind', 'deleted');
  expect(await storedRows(page, DOCX, 'file')).toBeGreaterThan(0);
});

// Review 2026-11-20: the toast's Download writes a real .docx, the editor's
// export over the base the edits grew from.
test("a deleted DOCX's Download saves its unsent edits as a .docx", async ({
  page,
}) => {
  skipWhileFilesViewOnly();
  test.setTimeout(240_000);
  await typeDocxOffline(page, ' Typed before the delete.');
  await deleteItem(page, DOCX, 'doc', DOCX_NAME);
  await navigate(page, WORKSPACE);
  await expect(page.locator('iframe[src*="office-runtime"]')).toHaveCount(0);
  await setOnline(page, true);
  await page.reload();

  const offer = toast(page, DOCX_NAME);
  await expect(offer).toBeVisible({ timeout: 60_000 });
  const saving = page.waitForEvent('download');
  await offer.getByRole('button', { name: m.action_download() }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(
    `Scenario document (${m.lost_edits_file()}).docx`
  );
  expect(await docxText(await file.path())).toContain(
    'Typed before the delete.'
  );
  await expect.poll(() => storedRows(page, DOCX, 'file')).toBe(0);
});

// Review 2026-11-20 (3): reopened at its edit link after the delete, the
// persisted file read painting first and the edit open starting early: its
// session read answers deleted as its token does, whichever comes first, so
// the unsent edits stay for the next load's offer.
test('a DOCX deleted while closed and reopened in edit mode keeps its unsent edits for the offer', async ({
  page,
}) => {
  skipWhileFilesViewOnly();
  test.setTimeout(240_000);
  await typeDocxOffline(page, ' Typed before the reopen.');
  await navigate(page, WORKSPACE);
  await expect(page.locator('iframe[src*="office-runtime"]')).toHaveCount(0);
  await deleteItem(page, DOCX, 'doc', DOCX_NAME);
  await setOnline(page, true);
  await page.goto(`${WORKSPACE}?file=${DOCX}&mode=edit`);
  await expect(page.getByText(m.error_not_found_title()).first()).toBeVisible({
    timeout: 60_000,
  });
  expect(await storedRows(page, DOCX, 'file')).toBeGreaterThan(0);

  await navigate(page, WORKSPACE);
  await page.reload();
  await expect(toast(page, DOCX_NAME)).toBeVisible({ timeout: 60_000 });
  expect(await storedRows(page, DOCX, 'file')).toBeGreaterThan(0);
});

// Review 2026-11-20 (4): a trash only queues the room's eviction, so a save
// may land first and fail not found; a fresh token says deleted, so the
// edits stay under the deleted strip rather than going back to the last save.
test('a DOCX whose save fails not found after its delete keeps its unsent edits under the deleted strip', async ({
  page,
}) => {
  skipWhileFilesViewOnly();
  test.setTimeout(240_000);
  await page.goto(`${WORKSPACE}?file=${DOCX}&mode=edit`);
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  await deleteItem(page, DOCX, 'doc', DOCX_NAME, false, true);
  const input = officeFrame(page).getByLabel('Document input');
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.pressSequentially(' Typed as it was deleted.');
  const strip = officeFrame(page).getByTestId('save-banner');
  await expect(strip).toHaveAttribute('data-kind', 'deleted', {
    timeout: 60_000,
  });
  expect(await storedRows(page, DOCX, 'file')).toBeGreaterThan(0);
});
