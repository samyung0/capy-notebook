import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/* Note Preview (Epo Q669 A, 2026-11-06): the editor stays mounted behind it and
 * Preview draws the readers' rendering from the live editor's text. Runs on a
 * note that keeps a device copy, where an unmount would come back on that copy. */

const NOTE = 'mock-scenario-note';
const SCENARIOS = `/workspaces/ws_scenarios?material=${NOTE}`;
const SEED = 'A note for trying application errors.';

const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');
const preview = (page: Page) => page.getByTestId('material-preview');
const pressPreview = (page: Page) =>
  page
    .getByRole('button', { exact: true, name: m.editor_embed_preview() })
    .click();
const pressEdit = (page: Page) =>
  page.getByRole('button', { exact: true, name: m.action_edit() }).click();

async function typeIntoNote(page: Page, typed: string) {
  await page.goto(SCENARIOS);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await editable(page).getByText(SEED).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await expect(editable(page)).toContainText(typed);
}

test('Edit comes back with the caret where it was', async ({ page }) => {
  await typeIntoNote(page, ' Before preview.');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Before preview.');
  await pressEdit(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.type(' Back.');
  await expect(editable(page)).toContainText('Before preview. Back.');
});

test('Undo after Preview and back takes back what was typed before it', async ({
  page,
}) => {
  await typeIntoNote(page, ' Before preview.');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Before preview.');
  await pressEdit(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await editable(page).getByText('Before preview.').click();
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editable(page)).not.toContainText('Before preview.', {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editable(page)).toContainText('Before preview.');
});

test('Preview shows a draft the room has not taken, and keeps it after', async ({
  page,
}) => {
  await page.goto(SCENARIOS);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(false);
  });
  await page.context().setOffline(true);
  await editable(page).getByText(SEED).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Unsent draft.');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Unsent draft.');
  await pressEdit(page);
  await expect(editable(page)).toContainText('Unsent draft.');
});

test('Preview opens with every read failing', async ({ page }) => {
  // MSW answers from its worker even with the browser offline, so reads are
  // failed in the page, as a real offline device's would.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (sessionStorage.getItem('e2e.reads.fail') && url.includes('/api/'))
        return Promise.reject(new TypeError('Failed to fetch'));
      return original(input, init);
    };
  });
  await typeIntoNote(page, ' Offline text.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(false);
    sessionStorage.setItem('e2e.reads.fail', 'true');
  });
  await page.context().setOffline(true);
  await pressPreview(page);
  await expect(preview(page)).toContainText('Offline text.');
});

test('toggling Preview reads nothing over the network', async ({ page }) => {
  await typeIntoNote(page, ' No read.');
  const reads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes(`/${NOTE}`))
      reads.push(request.url());
  });
  await pressPreview(page);
  await expect(preview(page)).toContainText('No read.');
  await pressEdit(page);
  await expect(editable(page)).toBeVisible();
  expect(reads).toEqual([]);
});

test("a collaborator's typing reaches an open Preview", async ({ page }) => {
  await typeIntoNote(page, ' Mine.');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Mine.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = await import(path);
    mockNotePeer('mock-scenario-note').append([
      { children: [{ text: 'Typed by a peer.' }], id: 'peer-line', type: 'p' },
    ]);
  });
  await expect(preview(page)).toContainText('Typed by a peer.');
});

test('Preview and back leaves a chat citation where it finished', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click({ timeout: 60_000 });
  await panel.locator('[data-scenario="chat-answer-note-citation"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 1 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await source.click();
  const flashed = page.locator('[data-citation-flash]');
  await expect(flashed).toHaveText('Third paragraph gamma', {
    timeout: 30_000,
  });
  await expect(flashed).toHaveCount(0);
  await pressPreview(page);
  await expect(preview(page)).toContainText('Third paragraph gamma');
  await pressEdit(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  // A flash would start as the editor shows again.
  await page.waitForTimeout(1000);
  await expect(flashed).toHaveCount(0);
});
