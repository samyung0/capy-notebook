import { type Browser, expect, type Page, test } from '@playwright/test';
import { slateNodesToInsertDelta } from '@slate-yjs/core';
import * as Y from 'yjs';
import {
  buildTableEndNoteValue,
  EDITOR_WORKSPACE_ID,
  TABLE_END_NOTE,
} from '../../src/mocks/editorSeed';

/* Opening never writes (Epo 2026-11-04): a note ending in a table used to get
 * a trailing paragraph from each editor that bound to it, so two people opening
 * together left two. Each page has its own mock room; both start from one stored
 * state, as two clients of the service do, and their rooms merge here as the
 * service would merge what each sent. */

const NOTE = TABLE_END_NOTE.id;
const ROOM = `material:${NOTE}:schema:1`;
const INTRO = 'Results before the table';

function storedState() {
  const doc = new Y.Doc();
  doc
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(buildTableEndNoteValue() as never));
  return Y.encodeStateAsUpdate(doc);
}

async function openNote(browser: Browser, stored: Uint8Array) {
  const context = await browser.newContext();
  await context.addInitScript(
    ([room, state]) => {
      sessionStorage.setItem(
        `capy.scenario.room.${room}`,
        JSON.stringify({ state, version: 1 })
      );
    },
    [ROOM, Array.from(stored)] as const
  );
  const page = await context.newPage();
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${NOTE}&mode=edit`
  );
  return page;
}

const editorReady = (page: Page) =>
  expect(
    page.locator('[contenteditable="true"]').getByText(INTRO).first()
  ).toBeVisible({ timeout: 60_000 });

const roomState = (page: Page) =>
  page.evaluate(async (id) => {
    const { mockNoteRoomState } = await import(
      '/src/mocks/collaboration.ts' as string
    );
    return mockNoteRoomState(id) as {
      blocks: string[];
      dirty: boolean;
      state: number[];
    };
  }, NOTE);

test('two people opening a note ending in a table write nothing', async ({
  browser,
}) => {
  const stored = storedState();
  const pages = await Promise.all([
    openNote(browser, stored),
    openNote(browser, stored),
  ]);
  await Promise.all(pages.map(editorReady));
  // A normalization runs in the bind's own task and flushes at once.
  await pages[0].waitForTimeout(1500);
  const rooms = await Promise.all(pages.map(roomState));
  const merged = new Y.Doc();
  Y.applyUpdate(merged, stored);
  const before = Y.encodeStateVector(merged);
  for (const room of rooms) {
    expect(room.dirty).toBe(false);
    Y.applyUpdate(merged, new Uint8Array(room.state));
  }
  expect(Y.encodeStateVector(merged)).toEqual(before);
});

test('a first edit brings the trailing paragraph, outside its Undo', async ({
  browser,
}) => {
  const page = await openNote(browser, storedState());
  await editorReady(page);
  await page.locator('[contenteditable="true"]').getByText(INTRO).click();
  // A click is no edit.
  expect((await roomState(page)).dirty).toBe(false);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect
    .poll(async () => (await roomState(page)).blocks)
    .toEqual(['p', 'table', 'p']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    page.locator('[contenteditable="true"]').getByText(`${INTRO}!`)
  ).toHaveCount(0);
  expect((await roomState(page)).blocks).toEqual(['p', 'table', 'p']);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(
    page.locator('[contenteditable="true"]').getByText(`${INTRO}!`)
  ).toBeVisible();
});

test('a click below a closing table opens a paragraph there', async ({
  browser,
}) => {
  const page = await openNote(browser, storedState());
  await editorReady(page);
  const editor = page.locator('[contenteditable="true"]').first();
  const box = (await editor.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
  await expect
    .poll(async () => (await roomState(page)).blocks)
    .toEqual(['p', 'table', 'p']);
  await page.keyboard.type('Below');
  await expect(
    editor.locator('p, [data-slate-node="element"]').last()
  ).toHaveText('Below');
});
