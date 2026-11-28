import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { FILES_VIEW_ONLY } from '../helpers/filesViewOnly';
import { openQuestionCard } from '../helpers/quizEditor';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

/**
 * Edits a room holds (round 4, item 10; Epo 2026-11-23). A group the room
 * dropped as late shows the `unsynced` strip: its Discard drops this tab's
 * drafts and joins afresh from the last saved version, its Retry joins again.
 * A Retry the room refuses for good shows recovery (`refused`), or the
 * access-lost strip when access went, never `unsynced` again. The refused
 * strip's Download saves the edits and its Discard ends them. Against the mock
 * rooms (src/mocks/collaboration.ts): `holdMockNoteEdits`, `holdMockItemEdits`
 * and `holdMockSourceEdits` hold the edits, which the room takes no part of
 * until the Retry; `refuseMockHeldRetry` refuses that Retry.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Hold = 'holdMockNoteEdits' | 'holdMockItemEdits' | 'holdMockSourceEdits';

const WORKSPACE = '/workspaces/ws_scenarios';
const NOTE = 'mock-scenario-note';
const SEED = 'A note for trying application errors.';
const QUIZ = 'mock-scenario-quiz';
const PROMPT = 'What is a cell?';
const TEXT = 'mock-scenario-text';
const HELD = ' Held edit.';
const HELD_TEXT = /Held edit\./;

const saveState = (page: Page) => page.getByTestId('editor-save-state');
const strip = (page: Page, kind: string) =>
  page.locator(`[data-testid="save-banner"][data-kind="${kind}"]`);

/** The room drops a group of `id`'s pieces as late; how many rooms hold. */
const hold = (page: Page, hook: Hold, id: string) =>
  page.evaluate(
    async ([name, itemId]) => {
      const path = '/src/mocks/collaboration.ts';
      const mocks = (await import(path)) as Collaboration;
      return mocks[name](itemId);
    },
    [hook, id] as const
  );

/** The next Retry of `id`'s held edits fails for good; how many holds. */
const refuseRetry = (page: Page, id: string, how: 'refused' | 'access') =>
  page.evaluate(
    async ([itemId, way]) => {
      const path = '/src/mocks/collaboration.ts';
      const { refuseMockHeldRetry } = (await import(path)) as Collaboration;
      return refuseMockHeldRetry(itemId, way);
    },
    [id, how] as const
  );

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

/** The text the note's open room holds. */
const noteRoomText = (page: Page) =>
  page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNoteRoomText } = (await import(path)) as Collaboration;
    return mockNoteRoomText(id);
  }, NOTE);

/** The unsynced strip's actions: Discard (ghost-hover), then Retry. */
async function unsyncedActions(page: Page) {
  const unsynced = strip(page, 'unsynced');
  await expect(unsynced).toBeVisible({ timeout: 30_000 });
  const actions = unsynced.getByRole('button');
  await expect(actions).toHaveText([
    m.action_discard(),
    m.error_action_retry(),
  ]);
  await expect(actions.first()).toHaveAttribute('data-variant', 'ghost-hover');
  return { discard: actions.first(), retry: actions.last(), unsynced };
}

/** The refused strip's actions: Discard (ghost-hover), then a dark Download. */
async function refusedActions(page: Page) {
  const refused = strip(page, 'refused');
  await expect(refused).toBeVisible({ timeout: 30_000 });
  const actions = refused.getByRole('button');
  await expect(actions).toHaveText([m.action_discard(), m.action_download()]);
  await expect(actions.first()).toHaveAttribute('data-variant', 'ghost-hover');
  await expect(actions.last()).toHaveAttribute('data-variant', 'dark');
  return { discard: actions.first(), download: actions.last(), refused };
}

const liveNote = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]').first();

async function openNote(page: Page) {
  await page.goto(`${WORKSPACE}?material=${NOTE}`);
  await expect(liveNote(page).getByText(SEED)).toBeVisible({
    timeout: 60_000,
  });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
}

/** The scenario quiz with its question's card open and its prompt's text
 * editor open, the caret at its end. */
async function openQuiz(page: Page) {
  const card = await openQuestionCard(page, `${WORKSPACE}?material=${QUIZ}`);
  await card.getByRole('button', { name: PROMPT }).first().click();
  const text = card.getByRole('textbox', {
    name: m.question_ui_text_and_formulas(),
  });
  await expect(text).toBeVisible();
  await clickTextEnd(text.getByText(PROMPT));
  return card;
}

/** The scenario text file in Edit, saved. */
async function openText(page: Page) {
  await page.goto(`${WORKSPACE}?file=${TEXT}&mode=edit`);
  const input = page.locator(`textarea[aria-label="${m.source_edit_raw()}"]`);
  await expect(input).toBeEditable({ timeout: 60_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  return input;
}

/** Holds `id`'s edits, types HELD, and sees it stored on this device. */
async function typeHeld(
  page: Page,
  hook: Hold,
  id: string,
  type: () => Promise<void>,
  kind = 'material'
) {
  // Once its rooms joined.
  await expect.poll(() => hold(page, hook, id)).toBeGreaterThan(0);
  const actions = await unsyncedActions(page);
  await type();
  await expect.poll(() => storedRows(page, id, kind)).toBeGreaterThan(0);
  return actions;
}

const typeNote = (page: Page) => async () => {
  await clickTextEnd(liveNote(page).getByText(SEED));
  await page.keyboard.type(HELD);
};
const typeQuiz = (page: Page) => async () => {
  await page.keyboard.type(HELD);
};
const typeText = (input: Locator) => async () => {
  await input.press('ControlOrMeta+End');
  await input.pressSequentially(HELD);
};

/** Clicks the unsynced strip's Retry, which `refuseRetry` failed for good. */
async function retryRefused(
  page: Page,
  retry: Locator,
  id: string,
  how: 'refused' | 'access'
) {
  expect(await refuseRetry(page, id, how)).toBeGreaterThan(0);
  await retry.click();
  // Pending for a moment, the join waiting (round 4, finding 4).
  await expect(retry).toBeDisabled();
}

// Item 10: the unsynced strip's Discard deletes this tab's drafts, and a fresh
// mount joins from the last saved version, the held edit gone.
test('a note’s unsynced Discard drops its held edit and joins afresh from the last saved version', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNote(page);
  const { discard, unsynced } = await typeHeld(
    page,
    'holdMockNoteEdits',
    NOTE,
    typeNote(page)
  );
  // Held: the room took none of it.
  const held = await noteRoomText(page);
  expect(held).toContain(SEED);
  expect(held).not.toMatch(HELD_TEXT);
  await discard.click();
  await expect(unsynced).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => storedRows(page, NOTE)).toBe(0);
  await expect(liveNote(page)).toContainText(SEED, { timeout: 30_000 });
  await expect(liveNote(page)).not.toContainText(HELD_TEXT);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const fresh = await noteRoomText(page);
  expect(fresh).toContain(SEED);
  expect(fresh).not.toMatch(HELD_TEXT);
});

test('a quiz’s unsynced Discard drops its held edit and joins afresh from the last saved version', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openQuiz(page);
  const { discard, unsynced } = await typeHeld(
    page,
    'holdMockItemEdits',
    QUIZ,
    typeQuiz(page)
  );
  await expect(page.getByText(HELD_TEXT).first()).toBeVisible();
  // Held, one change counts unsynced, as the room provider reports it, so
  // the header never reads saved meanwhile (round 6, finding 3).
  await expect(saveState(page)).not.toHaveAttribute('data-save-state', 'saved');
  // An item's Discard acts at once (a board's alone asks).
  await discard.click();
  await expect(unsynced).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => storedRows(page, QUIZ)).toBe(0);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await expect(page.getByText(PROMPT).first()).toBeVisible();
  await expect(page.getByText(HELD_TEXT)).toHaveCount(0);
});

// Item 10: a Retry the room refuses for good shows recovery, the edits kept
// to copy (or the access-lost strip when access went), never `unsynced` again.
test('a quiz’s Retry refused for good shows the refused strip with the held edit', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openQuiz(page);
  const { retry, unsynced } = await typeHeld(
    page,
    'holdMockItemEdits',
    QUIZ,
    typeQuiz(page)
  );
  await retryRefused(page, retry, QUIZ, 'refused');
  await refusedActions(page);
  await expect(unsynced).toHaveCount(0);
  await expect(page.getByText(HELD_TEXT).first()).toBeVisible();
  expect(await storedRows(page, QUIZ)).toBeGreaterThan(0);
});

test('a text file’s Retry refused for good shows the refused strip with the held edit', async ({
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(120_000);
  const input = await openText(page);
  const { retry, unsynced } = await typeHeld(
    page,
    'holdMockSourceEdits',
    TEXT,
    typeText(input),
    'file'
  );
  await retryRefused(page, retry, TEXT, 'refused');
  await refusedActions(page);
  await expect(unsynced).toHaveCount(0);
  await expect(page.locator('textarea[readonly]')).toHaveValue(HELD_TEXT);
  expect(await storedRows(page, TEXT, 'file')).toBeGreaterThan(0);
});

test('a quiz’s Retry refused for lost access shows the access-lost strip', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openQuiz(page);
  const { retry, unsynced } = await typeHeld(
    page,
    'holdMockItemEdits',
    QUIZ,
    typeQuiz(page)
  );
  await retryRefused(page, retry, QUIZ, 'access');
  await expect(page.getByText(m.editor_access_lost()).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(unsynced).toHaveCount(0);
  await expect(strip(page, 'refused')).toHaveCount(0);
});

test('a text file’s Retry refused for lost access shows the access-lost strip', async ({
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(120_000);
  const input = await openText(page);
  const { retry, unsynced } = await typeHeld(
    page,
    'holdMockSourceEdits',
    TEXT,
    typeText(input),
    'file'
  );
  await retryRefused(page, retry, TEXT, 'access');
  await expect(page.getByText(m.editor_access_lost()).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(unsynced).toHaveCount(0);
  await expect(strip(page, 'refused')).toHaveCount(0);
});

// Item 10: the refused strip downloads the edits it shows and keeps them;
// its Discard leaves recovery, the rows gone.
test('a quiz’s refused strip downloads the held edit, and Discard ends it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openQuiz(page);
  const { retry } = await typeHeld(
    page,
    'holdMockItemEdits',
    QUIZ,
    typeQuiz(page)
  );
  await retryRefused(page, retry, QUIZ, 'refused');
  const { discard, download, refused } = await refusedActions(page);
  const saving = page.waitForEvent('download');
  await download.click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe(
    `Scenario quiz (${m.lost_edits_file()}).json`
  );
  expect(await readFile(await file.path(), 'utf8')).toMatch(HELD_TEXT);
  await expect(refused).toBeVisible();
  expect(await storedRows(page, QUIZ)).toBeGreaterThan(0);

  await discard.click();
  await expect(refused).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => storedRows(page, QUIZ)).toBe(0);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await expect(page.getByText(PROMPT).first()).toBeVisible();
  await expect(page.getByText(HELD_TEXT)).toHaveCount(0);
});

test('a text file’s refused strip downloads the held edit, and Discard ends it', async ({
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(120_000);
  const input = await openText(page);
  const { retry } = await typeHeld(
    page,
    'holdMockSourceEdits',
    TEXT,
    typeText(input),
    'file'
  );
  await retryRefused(page, retry, TEXT, 'refused');
  const { discard, download, refused } = await refusedActions(page);
  const saving = page.waitForEvent('download');
  await download.click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe('Scenario source.txt');
  expect(await readFile(await file.path(), 'utf8')).toMatch(HELD_TEXT);
  await expect(refused).toBeVisible();
  expect(await storedRows(page, TEXT, 'file')).toBeGreaterThan(0);

  await discard.click();
  await expect(refused).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => storedRows(page, TEXT, 'file')).toBe(0);
  await expect(
    page.locator('textarea[aria-label]').filter({ visible: true }).first()
  ).not.toHaveValue(HELD_TEXT, { timeout: 30_000 });
});
