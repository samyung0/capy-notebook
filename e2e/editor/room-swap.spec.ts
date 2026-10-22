import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { officeEditMenu, officeMenu, saveOffice } from '../helpers/office';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

// A room reload swaps renderers (Epo 2026-10-22): the note or file on screen
// stays paused while the next room's renderer builds, then takes over at the
// same place. Set to a folder to keep screenshots of the paused state.
const shots = process.env.ROOM_SWAP_SCREENSHOTS;
const MATRIX = 'mat_note_bio_feature_matrix';
const SCENARIO_SEED = 'A note for trying application errors.';

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

/** The mock service holding the next room's answer (its open budget spent),
 * so the paused phase lasts until it is released. */
async function holdRooms(page: Page, held: boolean) {
  await page.evaluate(async (value) => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationSlowed } = await import(path);
    setCollaborationSlowed(value);
  }, held);
}

async function compact(page: Page, materialId: string) {
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { compactMockMaterialRoom } = await import(path);
    compactMockMaterialRoom(id);
  }, materialId);
}

const saveState = (page: Page) => page.getByTestId('editor-save-state');

/** Opens the long matrix note, saved, with a heading half way down at the
 * top of its scroll box; returns that heading's block id and offset. */
async function openScrolled(page: Page) {
  await openEditorNote(page, MATRIX, 'Editor feature matrix');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const heading = page
    .locator('[data-note-mount="live"] h2')
    .filter({ hasText: 'Text marks & styles' });
  await heading.evaluate((element) =>
    element.scrollIntoView({ block: 'start' })
  );
  // Away from the edge, so the restore has an offset to keep.
  await page
    .locator('[data-note-mount="live"] [data-note-scroll]')
    .evaluate((area) => {
      area.scrollTop -= 40;
    });
  return heading.evaluate(
    (element) =>
      element.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null
  );
}

/** A block's top below its mount's scroll box top. */
function offsetIn(page: Page, phase: string, id: string) {
  return page.evaluate(
    ({ block, mount }) => {
      const root = document.querySelector(`[data-note-mount="${mount}"]`);
      const area = root?.querySelector('[data-note-scroll]');
      const element = root?.querySelector(`[data-block-id="${block}"]`);
      if (!(area && element)) return null;
      return (
        element.getBoundingClientRect().top - area.getBoundingClientRect().top
      );
    },
    { block: id, mount: phase }
  );
}

test('a compaction keeps the note on screen read-only until the next editor paints, then shows it at the same block', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const block = await openScrolled(page);
  if (!block) throw new Error('The heading has no block id');
  const before = await offsetIn(page, 'live', block);
  if (before === null) throw new Error('The heading is not on screen');

  await holdRooms(page, true);
  await compact(page, MATRIX);
  // Paused: the old editor stays, read-only, beside the next one building
  // hidden; the header says Reconnecting.
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(paused).toBeVisible();
  await expect(paused).toContainText('Text marks & styles');
  await expect(paused.locator('[data-slate-editor]')).toHaveAttribute(
    'contenteditable',
    'false'
  );
  await expect(page.locator('[data-note-mount="standby"]')).toBeHidden();
  await expect(saveState(page)).toHaveAttribute(
    'data-save-state',
    'reconnecting'
  );
  expect(await offsetIn(page, 'paused', block)).toBe(before);
  await shot(page, 'paused-desktop');

  await holdRooms(page, false);
  await expect(paused).toHaveCount(0, { timeout: 30_000 });
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]').first()).toBeVisible();
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  const after = await offsetIn(page, 'live', block);
  expect(Math.abs((after ?? Number.NaN) - before)).toBeLessThan(2);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
});

test('a hidden tab swaps at once, with no paused note', async ({ page }) => {
  test.setTimeout(120_000);
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
  });
  await holdRooms(page, true);
  await compact(page, EDITOR_NOTE.id);
  // The next editor is already in place, still waiting for its room.
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.getByText(m.editor_connecting())).toBeVisible();
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0);
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  await holdRooms(page, false);
  await expect(live.locator('[contenteditable="true"]')).toContainText(
    EDITOR_NOTE.firstParagraph
  );
});

test.describe('on a phone', () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test('the editor remounts in place under a copy of the paused note', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
    await holdRooms(page, true);
    await compact(page, EDITOR_NOTE.id);
    // One renderer: the new editor in the old one's place, building under a
    // plain copy of the paused note that still reads and selects.
    const copy = page.locator('[data-paused-copy]');
    await expect(copy).toBeVisible();
    await expect(copy).toContainText(EDITOR_NOTE.secondParagraph);
    await expect(copy.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.locator('[data-note-mount]')).toHaveCount(1);
    await expect(page.locator('[data-note-mount="standby"]')).toBeAttached();
    await expect(saveState(page)).toHaveAttribute(
      'data-save-state',
      'reconnecting'
    );
    await shot(page, 'paused-360');
    await holdRooms(page, false);
    await expect(copy).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.locator('[data-note-mount="live"] [contenteditable="true"]')
    ).toContainText(EDITOR_NOTE.secondParagraph);
  });
});

test('a refused update keeps its edits for copying after the swap', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Drafts are stored for the scenario documents only under MSW.
  await page.goto(
    '/workspaces/ws_scenarios?material=mock-scenario-note&mode=edit'
  );
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText(SCENARIO_SEED, { timeout: 30_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  // Loaded first: the refusal has to land within the save's 1 s debounce.
  await page.evaluate(() => import('/src/mocks/collaboration.ts'));
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Kept for copying.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { rejectMockNoteUpdate } = await import(path);
    rejectMockNoteUpdate('mock-scenario-note');
  });
  const recovery = page.getByTestId('note-recovery');
  await expect(recovery).toContainText('Kept for copying.', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('save-banner')).toHaveAttribute(
    'data-kind',
    'refused'
  );
  await expect(recovery.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
});

test('a newer DOCX epoch swaps the editor with no banner or Reload', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const fileId = 'bio-office-docx';
  await page.goto(`/workspaces/ws_bio?file=${fileId}&mode=edit`);
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 120_000 });
  await saveOffice(page, 'docx');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const old = await page
    .locator('[data-office-view="live"] iframe')
    .elementHandle();
  // The reader is on page 4 (its canvas exists once the reader nears it).
  const pane = (view: string) =>
    page
      .frameLocator(`[data-office-view="${view}"] iframe`)
      .locator('.docx-editor__scroll-container');
  await expect
    .poll(
      () =>
        pane('live').evaluate((node) => {
          const fourth = node.querySelector('canvas[data-page-index="3"]');
          if (!fourth) {
            node.scrollTop += node.clientHeight;
            return false;
          }
          node.scrollTop +=
            fourth.getBoundingClientRect().top -
            node.getBoundingClientRect().top +
            40;
          return true;
        }),
      { timeout: 60_000 }
    )
    .toBe(true);

  await page.evaluate(async (id) => {
    const collaboration = '/src/mocks/collaboration.ts';
    const fixtures = '/src/mocks/scenarioFixtures.ts';
    const { announceSourceEpoch } = await import(collaboration);
    const { advanceScenarioSource } = await import(fixtures);
    announceSourceEpoch(id, advanceScenarioSource(id));
  }, fileId);
  // The paused view stays while the next one opens the new epoch hidden.
  await expect(page.locator('[data-office-view="replaced"]')).toBeVisible();
  const next = page.locator('[data-office-view="next"] iframe');
  await expect(next).toBeAttached();
  await expect(saveState(page)).toHaveAttribute(
    'data-save-state',
    'reconnecting'
  );
  const frame = await next.elementHandle();
  await shot(page, 'paused-docx');

  await expect(page.locator('[data-office-view="replaced"]')).toHaveCount(0, {
    timeout: 120_000,
  });
  // The frame that built hidden is the one on screen, never moved (a moved
  // frame reloads), and the old one is gone.
  const shown = page.locator('[data-office-view="live"] iframe');
  expect(await shown.evaluate((node, built) => node === built, frame)).toBe(
    true
  );
  expect(await old?.evaluate((node) => node.isConnected)).toBe(false);
  await expect(page.locator('iframe[src*="office-runtime"]')).toHaveCount(1);
  // At the same place: page 4 is on screen, by its first paragraph's id.
  await expect
    .poll(() =>
      pane('live').evaluate((node) => {
        const box = node.getBoundingClientRect();
        const fourth = node
          .querySelector('canvas[data-page-index="3"]')
          ?.getBoundingClientRect();
        return !!fourth && fourth.bottom > box.top && fourth.top < box.bottom;
      })
    )
    .toBe(true);
  await expect(page.getByText(m.source_edit_replaced())).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: m.error_action_reload() })
  ).toHaveCount(0);
  // Editing goes on in the new epoch: File › Save is enabled again.
  await officeMenu(page, 'docx', 'File').click();
  await expect(
    page.getByRole('menuitem', { name: /^Save/ })
  ).not.toHaveAttribute('aria-disabled', 'true');
});
