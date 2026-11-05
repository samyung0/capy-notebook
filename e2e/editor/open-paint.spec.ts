import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

/* The one way a note opens (Epo 2026-11-04): painted at once, from its device
 * copy or the stored projection, read-only, with Plate building behind it, and
 * the editor takes over silently at the same block and caret. */

const NOTE = 'mock-scenario-note';
const SCENARIOS = `/workspaces/ws_scenarios?material=${NOTE}`;
const MATRIX = 'mat_note_bio_feature_matrix';
const SEED = 'A note for trying application errors.';

const collaboration = (page: Page, run: string) =>
  page.evaluate(`(async () => {
    const c = await import('/src/mocks/collaboration.ts');
    ${run}
  })()`);

const painted = (page: Page) => page.getByTestId('material-preview');
const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');
const status = (page: Page) => page.getByTestId('editor-save-state');

async function saved(page: Page) {
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
}

async function typeIntoNote(page: Page, typed: string) {
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await editable(page).getByText(SEED).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await saved(page);
}

/** Reopens the note with its room's answer held back. */
async function reopenHeld(page: Page) {
  await collaboration(page, 'c.setCollaborationSlowed(true);');
  await page.reload();
}

const release = (page: Page) =>
  collaboration(page, 'c.setCollaborationSlowed(false);');

test('a note paints read-only with a spinner for its status, and turns editable once its room syncs', async ({
  page,
}) => {
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await reopenHeld(page);
  await expect(
    painted(page).getByText('Editor feature matrix').first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(status(page)).toHaveAttribute('data-save-state', 'opening');
  await expect(status(page)).not.toContainText(m.editor_connecting());
  await expect(editable(page)).toBeHidden();
  await release(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await expect(painted(page)).toHaveCount(0);
  await saved(page);
});

test('the editor takes over at the block and caret the reader had', async ({
  page,
}) => {
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await reopenHeld(page);
  const preview = painted(page);
  await expect(preview.getByText('Editor feature matrix').first()).toBeVisible({
    timeout: 30_000,
  });
  const box = page.locator('[data-note-paint]');
  await box.evaluate((node) => {
    node.scrollTop = 900;
  });
  // A caret placed in the note while it opens: the editor takes it.
  const line = preview.getByText('Editor feature matrix').first();
  const text = (await line.textContent()) ?? '';
  await line.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.querySelector('[data-testid="material-preview"]') as Node,
      NodeFilter.SHOW_TEXT
    );
    let node = walker.nextNode();
    while (node && !node.textContent?.includes('Editor feature matrix'))
      node = walker.nextNode();
    document.getSelection()?.collapse(node, 3);
  });
  expect(text.length).toBeGreaterThan(3);
  const before = await line.boundingBox();
  await release(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  const after = await editable(page)
    .getByText('Editor feature matrix')
    .first()
    .boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(40);
  await expect(editable(page)).toBeFocused();
  await page.keyboard.type('@@');
  await expect(
    editable(page).getByText('Edi@@tor feature matrix').first()
  ).toBeVisible();
});

test('a reopen paints from the device copy, joins by difference and edits on', async ({
  page,
}) => {
  await page.goto(SCENARIOS);
  await typeIntoNote(page, ' kept');
  await page.reload();
  // The room's join held: the note shows what the device kept.
  await expect(painted(page).getByText(`${SEED} kept`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await saved(page);
  await clickTextEnd(editable(page).getByText(`${SEED} kept`));
  await page.keyboard.type(' more');
  await saved(page);
  expect(
    await page.evaluate(async (id) => {
      const { mockNoteRoomText } = await import(
        '/src/mocks/collaboration.ts' as string
      );
      return mockNoteRoomText(id) as string;
    }, NOTE)
  ).toContain('kept more');
});

test('a refused room takes the copy with it and the next mount starts empty', async ({
  page,
}) => {
  await page.goto(SCENARIOS);
  await typeIntoNote(page, ' kept');
  await page.reload();
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await collaboration(page, `c.rejectMockNoteUpdate('${NOTE}', 'unassigned');`);
  const keys = () =>
    page.evaluate(async () =>
      (await (await caches.open('capy-source-bytes')).keys()).map(
        (request) => new URL(request.url).pathname
      )
    );
  await expect
    .poll(async () => (await keys()).some((key) => key.includes('/copy/')))
    .toBe(false);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
});

test('a note this device holds reads without its body, and with it once its copy cannot paint', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/materials/${NOTE}`) reads.push(url.search);
  });
  await page.goto(SCENARIOS);
  await expect(editable(page)).toContainText(SEED, { timeout: 30_000 });
  await saved(page);
  expect(reads).not.toContain('?noContent=true');

  reads.length = 0;
  await page.reload();
  await expect(painted(page)).toContainText(SEED, { timeout: 30_000 });
  await expect(editable(page)).toContainText(SEED, { timeout: 30_000 });
  expect(reads).toEqual(['?noContent=true']);

  // The row stays and its bytes no longer read, once the page that would write
  // them went.
  await page.goto('/favicon.svg');
  reads.length = 0;
  await page.evaluate(async (id) => {
    const store = await caches.open('capy-source-bytes');
    const keys = await store.keys();
    const key = keys.find((request) =>
      request.url.includes(`copy/${id}/content`)
    );
    if (!key) throw new Error('No copy to break');
    const { headers } = (await store.match(key)) as Response;
    await store.put(
      key,
      new Response(new Uint8Array([255, 255, 255, 255]), { headers })
    );
  }, NOTE);
  await page.goto(SCENARIOS);
  await expect(editable(page)).toContainText(SEED, { timeout: 30_000 });
  expect(reads.slice(0, 2)).toEqual(['?noContent=true', '']);
});
