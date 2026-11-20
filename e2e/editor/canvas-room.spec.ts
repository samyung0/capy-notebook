import { expect, type Page, test } from '@playwright/test';

/**
 * A canvas in its collaboration room (Epo 2026-11-18), against the mock room
 * (src/mocks/collaboration.ts, the board room): two people on one canvas, a
 * reload, the picker's sharing switch (asking first), and a workspace viewer's read-only
 * board with its maker taking the canvas back.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Peer = ReturnType<Collaboration['mockBoardPeer']>;
type Board = { stats(): { canvas: string[] } };
type Shown = { __board?: Board; peer?: Peer };

/** A workspace's first canvas, as the mocks name it. */
const CANVAS = 'cv_ws_bio_1';

const drawn = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.stats().canvas ?? null);

async function boardShown(page: Page) {
  await page.waitForFunction(() => (window as Shown).__board);
  // The dev scenario panel sits over the toolbar's right end.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
}

async function openCanvas(page: Page) {
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
}

/** A pen stroke across the board's middle. */
async function drawStroke(page: Page) {
  await page.locator('edgeless-pen-tool-button').first().click();
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  const at = (x: number, y: number) =>
    [box.x + box.width * x, box.y + box.height * y] as const;
  await page.mouse.move(...at(0.4, 0.4));
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(...at(0.4 + step * 0.02, 0.4 + step * 0.015));
  await page.mouse.up();
}

/** Another person joins the canvas's room, headless, as `window.peer`; answers
 * the canvas as they hold it. */
const joinPeer = (page: Page, id: string) =>
  page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockBoardPeer } = (await import(modulePath)) as Collaboration;
    const peer = mockBoardPeer(canvasId);
    Object.assign(window, { peer });
    return peer.elements();
  }, id);

/** The peer draws `fields` again, a little further down, as `peer-stroke`. */
const peerDraws = (page: Page, fields: Record<string, unknown>) =>
  page.evaluate((stroke) => {
    const [x, y, w, h] = JSON.parse(String(stroke.xywh)) as number[];
    (window as Shown).peer?.add('peer-stroke', {
      ...stroke,
      xywh: JSON.stringify([x + 40, y + 80, w, h]),
    });
  }, fields);

const picker = (page: Page, title: string) =>
  page
    .locator('[data-workspace-canvas]')
    .getByRole('button', { exact: true, name: title });

test('two people draw on one canvas, and Undo takes back only its own stroke', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);

  // The other person has this tab's stroke as they join.
  const theirs = await joinPeer(page, CANVAS);
  const [stroke] = Object.values(theirs);
  expect(Object.values(theirs).map(({ type }) => type)).toEqual(['brush']);
  // Theirs shows here as they draw it.
  await peerDraws(page, stroke);
  await expect.poll(() => drawn(page)).toEqual(['brush', 'brush']);

  // Undo is this person's own: the peer's stroke stays on both.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  expect(
    await page.evaluate(() =>
      Object.keys((window as Shown).peer?.elements() ?? {})
    )
  ).toEqual(['peer-stroke']);
});

test('a reload shows the canvas as its room stored it', async ({ page }) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  // The room stores a moment after the last change; the page keeps nothing.
  await expect
    .poll(() =>
      page.evaluate(async (canvasId) => {
        const modulePath = '/src/mocks/collaboration.ts';
        const { mockBoardStored } = (await import(modulePath)) as Collaboration;
        return mockBoardStored(canvasId);
      }, CANVAS)
    )
    .toBe(true);
  await page.reload();
  await boardShown(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
});

test("the picker's switch asks before it shares a canvas with the members, and takes it back at once", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  const trigger = picker(page, 'Biology 101');
  await trigger.click();
  const shared = page.getByRole('switch', { name: 'Shared with members' });
  // The people mark on the canvas's own row, read out with its name.
  const mark = page.getByRole('button', {
    name: /^Biology 101\s*Shared with members/,
  });
  await expect(shared).toHaveAttribute('aria-checked', 'false');
  await expect(mark).toHaveCount(0);
  // Between Rename and Delete, and the menu stays open.
  expect(
    await shared.evaluate((row) => [
      row.previousElementSibling?.textContent,
      row.nextElementSibling?.textContent,
    ])
  ).toEqual(['Rename', 'Delete']);
  // Sharing asks first, as a file's switch does (mock ShareDialog); Cancel
  // leaves it private.
  const ask = page.getByRole('dialog', {
    name: 'Share this canvas with members?',
  });
  await shared.click();
  await expect(ask).toBeVisible();
  await expect(
    ask.getByText(
      'Everyone in the workspace will see it. Editors can draw on it.'
    )
  ).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  if (!(await shared.isVisible())) await trigger.click();
  await expect(shared).toHaveAttribute('aria-checked', 'false');
  await shared.click();
  await ask.getByRole('button', { name: 'Share with members' }).click();
  if (!(await shared.isVisible())) await trigger.click();
  await expect(shared).toHaveAttribute('aria-checked', 'true');
  // Its row carries the people mark once the list has it.
  await expect(mark).toHaveCount(1);

  // Still shared when the picker opens again, which reads the list afresh.
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(shared).toHaveAttribute('aria-checked', 'true');
  // Taking it back does not ask.
  await shared.click();
  await expect(ask).toHaveCount(0);
  await expect(shared).toHaveAttribute('aria-checked', 'false');
  await expect(mark).toHaveCount(0);
});

test("a viewer opens another member's shared canvas read-only, and is told once when it is taken back", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCanvas(page);
  // A stroke as the board stores one, for the other member to draw.
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  const [stroke] = Object.values(await joinPeer(page, CANVAS));

  // Ben's shared canvas, which this person holds as a viewer.
  const theirs = await page.evaluate(async () => {
    const modulePath = '/src/mocks/canvas.ts';
    const { mockMemberCanvas } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/canvas');
    return mockMemberCanvas({
      creatorName: 'Ben',
      role: 'viewer',
      title: 'Lab diagrams',
      workspaceId: 'ws_bio',
    });
  });
  // The picker reads the list as it opens: his name before the time.
  await picker(page, 'Biology 101').click();
  const row = page.getByRole('button', { name: 'Lab diagrams' });
  await expect(row).toContainText('Ben ·');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await expect.poll(() => drawn(page)).toEqual([]);
  // This board stays to the end: a viewer's tab that wrote anything would
  // have its channel closed and its room opened afresh.
  await page.evaluate(() =>
    Object.assign((window as Shown).__board ?? {}, { first: true })
  );
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
    steps: 5,
  });
  await page.mouse.up();

  // No tools, and nothing of the canvas's to rename, share or delete.
  await expect(page.locator('edgeless-toolbar-widget')).toHaveCount(0);
  await picker(page, 'Lab diagrams').click();
  await expect(page.getByRole('button', { name: 'New canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // What Ben draws shows, on the board the drag opened on.
  await joinPeer(page, theirs);
  await peerDraws(page, stroke);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  expect(
    await page.evaluate(
      () => ((window as Shown).__board as { first?: boolean }).first
    )
  ).toBe(true);

  // Ben takes it back (Epo 2026-11-20): the canvas goes, a toast says they
  // lost access, once, and the picker shows their own.
  await page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockRevokeBoard } = (await import(modulePath)) as Collaboration;
    mockRevokeBoard(canvasId);
  }, theirs);
  const toast = page
    .getByRole('alert')
    .filter({ hasText: 'You no longer have access' });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(new RegExp(`c=${theirs}`));
  await expect(picker(page, 'Biology 101')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(toast).toHaveCount(1);
  await expect(page.locator('.tst-count')).toHaveCount(0);
  expect(errors).toEqual([]);
});
