import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';

/* Closing a note ends its document (Q913): Plate's awareness checks its peers
 * every 3 s until its Y.Doc is destroyed, and that live timer kept every closed
 * note's document in memory. The page records the 3 s intervals it runs. */

const WORKSPACE = `/workspaces/${EDITOR_WORKSPACE_ID}`;

type Timers = { liveTimers: () => number[] };

/** In-app navigation: the note unmounts, the page stays. */
const navigate = (page: Page, url: string) =>
  page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);

const liveTimers = (page: Page) =>
  page.evaluate(() => (window as unknown as Timers).liveTimers());

test('closing a note stops its awareness timer and frees its document', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const live = new Set<number>();
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.setInterval = ((handler, timeout, ...args) => {
      const id = set(handler, timeout, ...args);
      if (timeout === 3000) live.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id) => {
      if (id !== undefined) live.delete(id);
      clear(id);
    };
    (window as unknown as Timers).liveTimers = () => [...live];
  });
  await page.goto(WORKSPACE);
  await page.waitForLoadState('networkidle');
  const before = new Set(await liveTimers(page));

  await navigate(page, `${WORKSPACE}?material=${EDITOR_NOTE.id}`);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(
    editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true })
  ).toBeVisible({ timeout: 60_000 });
  let started: number[] = [];
  await expect
    .poll(async () => {
      started = (await liveTimers(page)).filter((id) => !before.has(id));
      return started.length;
    })
    .toBeGreaterThan(0);

  await navigate(page, WORKSPACE);
  await expect(page.locator('[data-note-mount]')).toHaveCount(0);
  await expect
    .poll(async () => {
      const live = new Set(await liveTimers(page));
      return started.filter((id) => live.has(id));
    })
    .toEqual([]);
});
