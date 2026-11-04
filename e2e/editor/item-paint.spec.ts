import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/* The items' one way of opening (Epo 2026-11-04): painted from the read or the
 * device copy, in the editor's layout and taking no input, until their rooms
 * sync. Copies keep their rooms' confirmed state and the last read. */

const QUIZ = 'mock-scenario-quiz';
const CARDS = 'mock-scenario-cards';
const open = (id: string) => `/workspaces/ws_scenarios?material=${id}`;

/** Holds `id`'s room tokens, across page loads, or lets them go (null). */
const holdTokens = (page: Page, id: string | null) =>
  page.evaluate(async (held) => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteTokens } = await import(path);
    holdNoteTokens(held);
  }, id);

/** The documents this device keeps of `id`, by the store's entries. */
const copies = (page: Page, id: string) =>
  page.evaluate(async (material) => {
    const store = await caches.open('capy-source-bytes');
    const keys = await store.keys();
    return keys
      .map((request) => decodeURIComponent(new URL(request.url).pathname))
      .flatMap((path) => {
        const at = path.indexOf(`copy/${material}/`);
        return at < 0 ? [] : [path.slice(at + material.length + 6)];
      })
      .sort();
  }, id);

const status = (page: Page) => page.getByTestId('editor-save-state');

test('a quiz paints without its Edit rows until its rooms sync, then keeps its copies', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(open(QUIZ));
  await expect(page.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await holdTokens(page, QUIZ);
  await page.reload();
  await expect(page.locator('[data-question-id]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-question-edit]')).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-save-state', 'opening');
  await expect
    .poll(() => copies(page, QUIZ))
    .toEqual(['content', 'keys', 'read']);
  await holdTokens(page, null);
  await expect(page.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
});

test('someone gone from editing to viewing loses the answer keys copy', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(open(QUIZ));
  await expect(page.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => copies(page, QUIZ)).toContain('keys');
  await page.evaluate(async (id) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const row = db.materials.find((item: { id: string }) => item.id === id);
    row.capabilities = { ...row.capabilities, canEditContent: false };
  }, QUIZ);
  const home = () =>
    page.evaluate((url) => {
      history.pushState({}, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, '/workspaces/ws_scenarios');
  await home();
  await expect(page.locator('[data-question-id]')).toHaveCount(0);
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, open(QUIZ));
  await expect(page.locator('[data-question-id]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-question-edit]')).toHaveCount(0);
  await expect.poll(() => copies(page, QUIZ)).not.toContain('keys');
});

test('a set paints its cards with nothing to press until its room syncs', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(open(CARDS));
  const add = page.getByText(m.flashcards_add_card());
  await expect(add).toBeVisible({ timeout: 30_000 });
  await holdTokens(page, CARDS);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await expect(status(page)).toHaveAttribute('data-save-state', 'opening');
  await expect(add).toHaveCount(0);
  await expect.poll(() => copies(page, CARDS)).toEqual(['content', 'read']);
  await holdTokens(page, null);
  await expect(add).toBeVisible({ timeout: 30_000 });
});

test('a diagram paints its source and picture, read-only, until its room syncs', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/workspaces/ws_bio?material=mat_2');
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await holdTokens(page, 'mat_2');
  await page.reload();
  await expect(page.getByText('Ribosome --> RoughER')).toBeVisible({
    timeout: 30_000,
  });
  await expect(status(page)).toHaveAttribute('data-save-state', 'opening');
  // Nothing to press or type into yet.
  await expect(
    page.locator('[inert]').getByText('Ribosome --> RoughER')
  ).toBeVisible();
  await holdTokens(page, null);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await page.getByText('Ribosome --> RoughER').click();
  await page.keyboard.type('Zzqq');
  await expect(page.getByText('Zzqq').first()).toBeVisible();
});
