import { expect, type Page, test } from '@playwright/test';

/**
 * A board note's caret and the page's selection. A note's text editor reads
 * the page's selection after it renders only when it may hold it
 * (vendor/blocksuite local change 66): typing, a composition, another note
 * changing while the caret is elsewhere, and leaving a note keep working.
 */

type Root = HTMLElement & {
  std: {
    store: {
      getBlock(id: string): {
        model: { props: { text: { insert(text: string, at: number): void } } };
      } | null;
    };
  };
};

async function openBoard(page: Page) {
  await page.goto('/dev/drawing');
  await page.waitForFunction(() =>
    (
      window as unknown as { __board?: { stats(): { canvas: string[] } } }
    ).__board
      ?.stats()
      .canvas.includes('plane')
  );
}

/** A new note at a fraction of the board, holding the caret. */
async function newNote(page: Page, x: number, y: number) {
  const board = await page.locator('affine-edgeless-root').boundingBox();
  if (!board) throw new Error('no board');
  await page.locator('capy-note-button').first().click();
  await page
    .locator('edgeless-note-menu edgeless-tool-icon-button')
    .first()
    .click();
  await page.mouse.click(board.x + board.width * x, board.y + board.height * y);
  const count = await page.locator('affine-edgeless-note').count();
  // The new note takes the focus a moment later on a loaded machine.
  await page.waitForFunction(
    (count) =>
      document.activeElement?.closest('affine-edgeless-note') ===
      document.querySelectorAll('affine-edgeless-note')[count - 1],
    count
  );
}

/** The note the page's selection is in, by its place among the notes. */
const selectedNote = (page: Page) =>
  page.evaluate(() => {
    const selection = document.getSelection();
    const node = selection?.rangeCount ? selection.anchorNode : null;
    const element = node instanceof Element ? node : node?.parentElement;
    const note = element?.closest('affine-edgeless-note');
    return note
      ? [...document.querySelectorAll('affine-edgeless-note')].indexOf(note)
      : null;
  });

test("a note's caret stays while another note changes, and leaving a note takes its selection", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  await newNote(page, 0.25, 0.25);
  await page.keyboard.type('first');
  await page.keyboard.press('Escape');
  await newNote(page, 0.6, 0.7);
  await page.keyboard.type('second');
  const notes = page.locator('affine-edgeless-note');
  await expect(notes.nth(1)).toContainText('second');
  expect(await selectedNote(page)).toBe(1);

  // The first note renders again, as a peer's edit makes it: the caret stays
  // in the second, where the next keys land.
  await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as Root;
    const note = document.querySelector('affine-edgeless-note') as unknown as {
      model: { children: { id: string }[] };
    };
    root.std.store
      .getBlock(note.model.children[0].id)
      ?.model.props.text.insert('>', 0);
  });
  await expect(notes.first()).toContainText('>first');
  await page.keyboard.type(' more');
  await expect(notes.nth(1)).toContainText('second more');
  await expect(notes.first()).toContainText('>first');
  expect(await selectedNote(page)).toBe(1);

  // A selection in a note goes with its editing.
  await page.keyboard.press('Shift+Home');
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString()))
    .toBe('second more');
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedNote(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('a composition types into a note once', async ({ page }) => {
  test.slow();
  await openBoard(page);
  await newNote(page, 0.4, 0.4);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    selectionEnd: 2,
    selectionStart: 2,
    text: 'ni',
  });
  await cdp.send('Input.insertText', { text: '你' });
  await page.keyboard.type('a');
  await expect(page.locator('affine-edgeless-note')).toContainText('你a');
  await expect(page.locator('affine-edgeless-note')).not.toContainText('ni');
});
