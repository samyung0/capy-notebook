import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { officeEditMenu, officeMenu, saveOffice } from '../helpers/office';
import { m } from '../i18n';
import { clickTextEnd, openEditorNote } from './helpers';

// A room reload swaps renderers (Epo 2026-10-22): the note or file on screen
// stays paused while the next room's renderer builds, then takes over at the
// same place. Set to a folder to keep screenshots of the paused state.
const shots = process.env.ROOM_SWAP_SCREENSHOTS;
const MATRIX = 'mat_note_bio_feature_matrix';
const SCENARIO_SEED = 'A note for trying application errors.';
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

/** The service discards unsaved room state and moves the note's room on:
 * its open editors' channels close and their rejoin swaps to the next room. */
async function discard(page: Page, materialId: string) {
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { discardMockMaterialRoom } = await import(path);
    discardMockMaterialRoom(id);
  }, materialId);
}

const saveState = (page: Page) => page.getByTestId('editor-save-state');

const INTRO = 'intentionally exercises every Plate feature';

/** Opens the long matrix note, saved, with a heading half way down at the
 * top of its scroll box (with `caret`, the caret first goes into the intro
 * paragraph near the top); returns that heading's block id. */
async function openScrolled(page: Page, caret = false) {
  await openEditorNote(page, MATRIX, 'Editor feature matrix');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  if (caret)
    await page.locator('[data-note-mount="live"]').getByText(INTRO).click();
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

test('a discard keeps the note on screen read-only until the next editor paints, then shows it at the same block', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const block = await openScrolled(page);
  if (!block) throw new Error('The heading has no block id');
  const before = await offsetIn(page, 'live', block);
  if (before === null) throw new Error('The heading is not on screen');

  await holdRooms(page, true);
  await discard(page, MATRIX);
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
  await discard(page, EDITOR_NOTE.id);
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

// A note's join has the same 30 s (Epo 2026-10-23): a JOIN never answered
// on the open socket keeps the paused note under Reconnecting until then,
// and the failing editor takes its place with the connection error.
test("a note reload whose JOIN is never answered ends at the join's 30 s", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { holdRoomJoins } = await import(path);
    holdRoomJoins(true);
  });
  await discard(page, EDITOR_NOTE.id);
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(paused).toBeVisible();
  await expect(saveState(page)).toHaveAttribute(
    'data-save-state',
    'reconnecting'
  );
  await page.waitForTimeout(15_000);
  await expect(paused).toBeVisible();
  await expect(paused).toHaveCount(0, { timeout: 60_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'error');
});

// A note's join starts at its token request (Epo 2026-10-23): a first open
// whose token never answers ends in the connection error 30 s on, not a
// loading pane for ever. Timed from the page's last token request, not the
// load: a busy runner sends it up to 40 s after the load, and a reload (MSW's,
// while its worker does not control the page yet) starts the join again.
test("a first open whose token request hangs ends at the join's 30 s", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/workspaces/${EDITOR_WORKSPACE_ID}`);
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteTokens } = await import(path);
    holdNoteTokens(id);
  }, EDITOR_NOTE.id);
  let requested = 0;
  page.on('request', (request) => {
    if (
      request.url().endsWith(`/materials/${EDITOR_NOTE.id}/collaboration-token`)
    )
      requested = Date.now();
  });
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${EDITOR_NOTE.id}&mode=edit`
  );
  const failed = page.getByText(m.editor_collab_unavailable());
  await expect(failed).toBeVisible({ timeout: 90_000 });
  const shown = Date.now() - requested;
  expect(shown).toBeGreaterThan(28_000);
  expect(shown).toBeLessThan(38_000);
  await expect(page.locator('[data-note-mount]')).toHaveCount(0);
});

// CAPY-WEB-7: a first open whose token answers after the join's 30 s paints
// the note before its room syncs. A caret placed then, and Plate binding the
// editor to the still empty document after 5 s, threw "Path doesn't match
// yText" on every change and the next media insert never uploaded. The
// editor binds at the room's sync instead and keeps working.
test('a note painted before its room synced binds at the sync and takes edits and media', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/workspaces/${EDITOR_WORKSPACE_ID}`);
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteTokens, setCollaborationSlowed } = await import(path);
    holdNoteTokens(id, 31_000);
    setCollaborationSlowed(true);
  }, EDITOR_NOTE.id);
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${EDITOR_NOTE.id}&mode=edit`
  );
  const editor = page.locator('[contenteditable="true"]').first();
  const third = editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true });
  // The token's 31 s, plus a reload if the dev server optimizes then.
  await expect(third).toBeVisible({ timeout: 90_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'error');
  await clickTextEnd(third);
  // Past Plate's 5 s wait for the sync: the note is still shown.
  await page.waitForTimeout(6000);
  await expect(third).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteTokens, setCollaborationSlowed } = await import(path);
    holdNoteTokens(null);
    setCollaborationSlowed(false);
  });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  // The room's four blocks, and no paragraph only the editor holds.
  await expect(
    editor.locator('[data-block-id]:not([data-block-id] *)')
  ).toHaveCount(4);
  await clickTextEnd(third);
  await page.keyboard.type(' bound');
  await expect(
    editor.getByText(`${EDITOR_NOTE.thirdParagraph} bound`, { exact: true })
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await editor.evaluate((element, b64) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'bound.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      })
    );
  }, PNG_B64);
  await expect(editor.getByRole('img', { name: 'bound.png' })).toBeVisible();
  expect(errors).toEqual([]);
});

// A reload's join counts from its token request too (Epo 2026-10-23): a
// token answering after 20 s leaves its editor about 10 s to join, not 30.
test("a note reload's join counts its 30 s from the token request", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { holdNoteTokens, holdRoomJoins } = await import(path);
    holdNoteTokens(id, 20_000);
    holdRoomJoins(true);
  }, EDITOR_NOTE.id);
  const requested = Date.now();
  await discard(page, EDITOR_NOTE.id);
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(paused).toBeVisible({ timeout: 30_000 });
  // About 30 s after the request; counting from the editor's mount would
  // take about 50.
  await expect(paused).toHaveCount(0, {
    timeout: requested + 38_000 - Date.now(),
  });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'error');
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
    await discard(page, EDITOR_NOTE.id);
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

// Q251: a refused update's edits come back after the swap as the merge
// view's pieces on the live note (no copy-only renderer), and Apply mine is
// one Undo step.
test("a refused update's edits come back as pieces after the swap", async ({
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
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    await import(path);
  });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Refused text.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { rejectMockNoteUpdate } = await import(path);
    rejectMockNoteUpdate('mock-scenario-note');
  });
  const strip = page.locator('[data-testid="save-banner"][data-kind="review"]');
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  await expect(editor).toContainText(SCENARIO_SEED);
  await expect(editor).not.toContainText('Refused text.');
  await strip.getByRole('button', { name: m.merge_review() }).click();
  const piece = page.locator('[data-merge-piece="mock-scenario-note-intro"]');
  await expect(piece).toHaveAttribute('data-status', 'conflict');
  await expect(piece).toContainText('Refused text.');
  await piece.getByRole('button').first().click();
  await piece.getByRole('button', { name: m.merge_apply() }).click();
  await expect(piece).toHaveAttribute('data-status', 'resolved');
  await expect(editor).toContainText('Refused text.');
  await expect(strip).toHaveCount(0);
  // In the room: a peer reads it.
  const peerText = await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    const peer = mockNotePeer('mock-scenario-note');
    const text = String(peer.document.get('content'));
    peer.leave();
    return text;
  });
  expect(peerText).toContain('Refused text.');
  // Undo takes the choice back, and the piece is to review again. The sheet
  // covers the note's right side: focus it at its left edge.
  await editor.click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(editor).not.toContainText('Refused text.');
  await expect(piece).toHaveAttribute('data-status', 'conflict');
  await expect(strip).toBeVisible();
});

// The reading place wins over a restored caret, and the focus the editor
// held as it paused comes back with the selection (review r2 M1/M2): the
// caret in the intro near the top, the reader half way down.
test('a swap keeps the reading place and gives the caret back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const block = await openScrolled(page, true);
  if (!block) throw new Error('The heading has no block id');
  const before = await offsetIn(page, 'live', block);
  if (before === null) throw new Error('The heading is not on screen');
  const intro = await page.evaluate(
    () =>
      document
        .getSelection()
        ?.anchorNode?.parentElement?.closest('[data-block-id]')
        ?.getAttribute('data-block-id') ?? null
  );
  if (!intro) throw new Error('The caret is not in a block');

  await holdRooms(page, true);
  await discard(page, MATRIX);
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(paused).toBeVisible();
  await holdRooms(page, false);
  await expect(paused).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);

  // Still at the block for a while after the swap: a late caret scroll would
  // move it within a few frames.
  const drift = await page.evaluate(
    ({ id, start }) =>
      new Promise<number>((resolve) => {
        const root = document.querySelector('[data-note-mount="live"]');
        const area = root?.querySelector('[data-note-scroll]');
        const element = root?.querySelector(`[data-block-id="${id}"]`);
        if (!(area && element)) return resolve(Number.POSITIVE_INFINITY);
        let most = 0;
        const until = performance.now() + 500;
        const sample = () => {
          const offset =
            element.getBoundingClientRect().top -
            area.getBoundingClientRect().top;
          most = Math.max(most, Math.abs(offset - start));
          if (performance.now() < until) requestAnimationFrame(sample);
          else resolve(most);
        };
        sample();
      }),
    { id: block, start: before }
  );
  expect(drift).toBeLessThan(2);

  // The live editor has the focus, its caret in the intro, and typing lands
  // there.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.matches(
            '[data-note-mount="live"] [data-slate-editor]'
          ) ?? false
      )
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        document
          .getSelection()
          ?.anchorNode?.parentElement?.closest('[data-block-id]')
          ?.getAttribute('data-block-id') ?? null
    )
  ).toBe(intro);
  const introBlock = page.locator(
    `[data-note-mount="live"] [data-block-id="${intro}"]`
  );
  const marks = async () =>
    ((await introBlock.textContent()) ?? '').split('Q').length - 1;
  const typed = (await marks()) + 1;
  await page.keyboard.type('Q');
  await expect.poll(marks).toBe(typed);
});

// A paused note takes no edit by any path (review M1): its model takes only
// selection changes, and typing, paste, drops and right clicks stop in the
// DOM. Its widths and text stay as they were.
test('a paused note takes no edit', async ({ page }) => {
  test.setTimeout(180_000);
  await openEditorNote(page, MATRIX, 'Editor feature matrix');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const live = page.locator('[data-note-mount="live"] [data-slate-editor]');
  // The blocks the edits below aim at (embeds keep loading, so not the
  // whole note).
  const texts = (root: Element, intro: string) => {
    const blocks = [...root.querySelectorAll('[data-block-id]')];
    return [
      blocks[0]?.textContent,
      blocks.find((block) => block.textContent?.includes(intro))?.textContent,
      root.querySelector('h2')?.textContent,
      root.querySelector('table')?.textContent,
    ];
  };
  const text = await live.evaluate(texts, INTRO);
  // An IME composition open when the pause lands.
  await live.getByText(INTRO).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    selectionEnd: 1,
    selectionStart: 1,
    text: 'か',
  });
  await holdRooms(page, true);
  await discard(page, MATRIX);
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(paused).toBeVisible();
  const content = paused.locator('[data-slate-editor]');
  const widths = () =>
    content.evaluate((root) => ({
      cells: [...root.querySelectorAll('table tr:first-child > *')].map(
        (cell) => Math.round(cell.getBoundingClientRect().width)
      ),
      media: [
        ...root.querySelectorAll('[data-media-resize-handle="right"]'),
      ].map((handle) =>
        Math.round(handle.parentElement?.getBoundingClientRect().width ?? 0)
      ),
    }));
  const laidOut = await widths();
  expect(laidOut.cells.length).toBeGreaterThan(1);
  expect(laidOut.media.length).toBeGreaterThan(0);

  // Typing, a paste and a drop.
  await content.getByText(INTRO).click();
  await page.keyboard.type('zz');
  await content.evaluate((root) => {
    const target = root.querySelector('[data-block-id]');
    const data = new DataTransfer();
    data.setData('text/plain', 'pasted');
    target?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      })
    );
    target?.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      })
    );
  });
  // The block menu does not open.
  await content.locator('h2').first().click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  // A table column and a figure resized by their handles.
  const drag = async (selector: string, by: number) => {
    const handle = content.locator(selector).first();
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) throw new Error(`No ${selector} on screen`);
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height / 2, 12);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + by, y, { steps: 6 });
    await page.mouse.up();
  };
  await drag('table .cursor-col-resize', 80);
  await drag('[data-media-resize-handle="right"]', -80);

  await page.waitForTimeout(500);
  expect(await content.evaluate(texts, INTRO)).toEqual(text);
  expect(await widths()).toEqual(laidOut);
  await holdRooms(page, false);
  await expect(paused).toHaveCount(0, { timeout: 30_000 });
});

// The swap's path is decided once (review M3): a desktop build that crosses
// to phone width still swaps when it paints.
test('a breakpoint crossing during a build still swaps', async ({ page }) => {
  test.setTimeout(120_000);
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await holdRooms(page, true);
  await discard(page, EDITOR_NOTE.id);
  await expect(page.locator('[data-note-mount="paused"]')).toBeVisible();
  await expect(page.locator('[data-note-mount="standby"]')).toBeAttached();
  await page.setViewportSize({ height: 740, width: 360 });
  await holdRooms(page, false);
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    page.locator('[data-note-mount="live"] [contenteditable="true"]')
  ).toContainText(EDITOR_NOTE.secondParagraph);
});

// A second reload during a build drops the stale build for the newest room.
test('a reload during a build swaps to the newest room', async ({ page }) => {
  test.setTimeout(120_000);
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await holdRooms(page, true);
  await discard(page, EDITOR_NOTE.id);
  await expect(page.locator('[data-note-mount="standby"]')).toBeAttached();
  await discard(page, EDITOR_NOTE.id);
  await holdRooms(page, false);
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(EDITOR_NOTE.secondParagraph);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
});

// Leaving a note while its next renderer builds leaves nothing behind.
test('leaving a note during its build opens the next one cleanly', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openEditorNote(page, MATRIX, 'Editor feature matrix');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await holdRooms(page, true);
  await discard(page, MATRIX);
  await expect(page.locator('[data-note-mount="paused"]')).toBeVisible();
  await page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { exact: true, name: EDITOR_NOTE.title })
    .click();
  await holdRooms(page, false);
  // The other note opens in View; the building editor went with the first.
  await expect(page.getByTestId('material-preview')).toContainText(
    EDITOR_NOTE.firstParagraph,
    { timeout: 30_000 }
  );
  await expect(page.locator('[data-note-mount]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

const DOCX = 'bio-office-docx';

/** The DOCX editor's scroll box in a view slot's frame. */
const docxPane = (page: Page, view: string) =>
  page
    .frameLocator(`[data-office-view="${view}"] iframe`)
    .locator('.docx-editor__scroll-container');

/** Whether a DOCX page (0-based) shows in a view slot's scroll box. */
const pageInView = (page: Page, view: string, index: number) =>
  docxPane(page, view).evaluate((node, at) => {
    const box = node.getBoundingClientRect();
    const canvas = node
      .querySelector(`canvas[data-page-index="${at}"]`)
      ?.getBoundingClientRect();
    return !!canvas && canvas.bottom > box.top && canvas.top < box.bottom;
  }, index);

/** Opens the DOCX for editing, saved, with the reader on page 4 (its canvas
 * exists once the reader nears it) and the caret left on page 1; with
 * `typing`, the document input holds the focus. */
async function openDocxOnPage4(page: Page, typing = false) {
  await page.goto(`/workspaces/ws_bio?file=${DOCX}&mode=edit`);
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 120_000 });
  await saveOffice(page, 'docx');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  if (typing) {
    const input = page
      .frameLocator('[data-office-view="live"] iframe')
      .getByLabel('Document input');
    await input.focus();
    await expect(input).toBeFocused();
  }
  await expect
    .poll(
      () =>
        docxPane(page, 'live').evaluate((node) => {
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
  return docxPane(page, 'live').evaluate((node) => node.scrollTop);
}

// BetterOffice going read-only never moves the view (Epo 2026-10-22): the
// caret stays on page 1 and the reader on page 4.
test('a DOCX maintenance pause keeps the reader where they are', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const before = await openDocxOnPage4(page);
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { announceSourcePaused } = await import(path);
    announceSourcePaused(id);
  }, DOCX);
  await expect(page.getByText(m.source_edit_paused())).toBeVisible();
  // The read-only switch lays the pages out again.
  await page.waitForTimeout(2000);
  expect(await docxPane(page, 'live').evaluate((node) => node.scrollTop)).toBe(
    before
  );
});

test('a newer DOCX epoch swaps the editor with no banner or Reload', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openDocxOnPage4(page);
  const old = await page
    .locator('[data-office-view="live"] iframe')
    .elementHandle();

  await newEpoch(page, DOCX);
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
  await expect.poll(() => pageInView(page, 'live', 3)).toBe(true);
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

/** A newer epoch for an open source file, as a base handoff announces it;
 * `hold` leaves the next view's JOIN unanswered or its session request
 * hanging. */
async function newEpoch(
  page: Page,
  fileId: string,
  hold: 'join' | 'session' | null = null
) {
  await page.evaluate(
    async ({ held, id }) => {
      const collaboration = '/src/mocks/collaboration.ts';
      const fixtures = '/src/mocks/scenarioFixtures.ts';
      const { announceSourceEpoch, holdRoomJoins, holdSourceSessions } =
        await import(collaboration);
      const { advanceScenarioSource } = await import(fixtures);
      if (held === 'join') holdRoomJoins(true);
      if (held === 'session') holdSourceSessions(true);
      announceSourceEpoch(id, advanceScenarioSource(id));
    },
    { held: hold, id: fileId }
  );
}

// A tab hidden during the build swaps at once and still opens at the
// reader's place once the next view settles (review L2).
test('a tab hidden during a DOCX build swaps at once at the same page', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openDocxOnPage4(page);
  await newEpoch(page, DOCX);
  await expect(page.locator('[data-office-view="next"] iframe')).toBeAttached();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('[data-office-view="replaced"]')).toHaveCount(0);
  await expect(page.locator('iframe[src*="office-runtime"]')).toHaveCount(1);
  await expect
    .poll(() => pageInView(page, 'live', 3), { timeout: 120_000 })
    .toBe(true);
});

// Every join, first or after a reload, has 30 s from its start (Epo
// 2026-10-23): the paused view stays under Reconnecting until then, and the
// failing view takes its place with the connection error.
for (const [hold, what] of [
  ['join', 'whose JOIN is never answered'],
  ['session', 'whose session request hangs'],
] as const)
  test(`a DOCX reload ${what} ends at the join's 30 s`, async ({ page }) => {
    test.setTimeout(300_000);
    await openDocxOnPage4(page);
    await newEpoch(page, DOCX, hold);
    const replaced = page.locator('[data-office-view="replaced"]');
    await expect(replaced).toBeVisible();
    await expect(saveState(page)).toHaveAttribute(
      'data-save-state',
      'reconnecting'
    );
    await page.waitForTimeout(15_000);
    await expect(replaced).toBeVisible();
    await expect(replaced).toHaveCount(0, { timeout: 60_000 });
    await expect(saveState(page)).toHaveAttribute('data-save-state', 'error');
  });

// A reader's edit that keeps the caret still brings it into view (review
// L1): forward Delete with the caret on page 1 and the reader on page 4.
test('a DOCX edit that keeps the caret brings it back into view', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openDocxOnPage4(page, true);
  expect(await pageInView(page, 'live', 0)).toBe(false);
  await page.keyboard.press('Delete');
  await expect.poll(() => pageInView(page, 'live', 0)).toBe(true);
});

// XLSX and PPTX swap at the reader's place too: the sheet (by id) with its
// selected cells, the slide.
test('a newer XLSX epoch swaps the editor at the same sheet and cell', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const fileId = 'bio-office-xlsx';
  await page.goto(`/workspaces/ws_bio?file=${fileId}&mode=edit`);
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 120_000 });
  await saveOffice(page, 'xlsx');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const frame = page.frameLocator('[data-office-view="live"] iframe');
  const nameBox = frame.getByRole('textbox', {
    name: m.files_office_spreadsheet_name_box(),
  });
  await nameBox.fill("'summary'!c4");
  await nameBox.press('Enter');
  await expect(nameBox).toHaveValue('C4');
  await newEpoch(page, fileId);
  await expect(page.locator('[data-office-view="replaced"]')).toBeVisible();
  await expect(page.locator('[data-office-view="replaced"]')).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(frame.getByRole('tab', { name: 'Summary' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(nameBox).toHaveValue('C4');
});

test('a newer PPTX epoch swaps the editor at the same slide', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const fileId = 'bio-office-pptx';
  await page.goto(`/workspaces/ws_bio?file=${fileId}&mode=edit`);
  await expect(officeEditMenu(page, 'pptx')).toBeVisible({ timeout: 120_000 });
  await saveOffice(page, 'pptx');
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  const slide = (index: number) =>
    page
      .frameLocator('[data-office-view="live"] iframe')
      .locator('aside button')
      .nth(index);
  await slide(2).click();
  await expect(slide(2)).toHaveAttribute('aria-current', 'page');
  await newEpoch(page, fileId);
  await expect(page.locator('[data-office-view="replaced"]')).toBeVisible();
  await expect(page.locator('[data-office-view="replaced"]')).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(slide(2)).toHaveAttribute('aria-current', 'page');
});
