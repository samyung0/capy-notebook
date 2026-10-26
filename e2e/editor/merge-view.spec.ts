import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// The note merge view (Epo 2026-10-24, Q251, Q252): edits that could not
// sync become pieces on this device, a strip offers Review and Discard, and
// the sheet's choices are ordinary edits of the live note. The scenario note
// keeps its room and drafts across reloads (MSW stores mock-scenario
// fixtures for the tab).
const NOTE = 'mock-scenario-note';
const note = `/workspaces/ws_scenarios?material=${NOTE}&mode=edit`;
const seed = 'A note for trying application errors.';
const INTRO = 'mock-scenario-note-intro';
// Set to a folder to keep screenshots of the strip and the sheet.
const shots = process.env.MERGE_VIEW_SCREENSHOTS;

type Peer = ReturnType<
  typeof import('../../src/mocks/collaboration').mockNotePeer
>;

async function openNote(page: Page) {
  await page.goto(note);
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  return editor;
}

async function typeAtEnd(page: Page, text: string) {
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

/** The note's stored rows by kind. */
async function storedKinds(page: Page) {
  return page.evaluate(async (id) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const rows: { kind: string }[] = await readDrafts(
      draftKey(user.id, 'material', id)
    );
    return rows.map((row) => row.kind).sort();
  }, NOTE);
}

/** Another editor in the note's room (the room must be open). */
async function joinPeer(page: Page) {
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    Object.assign(window, { peer: mockNotePeer(id) });
  }, NOTE);
}

async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

const strip = (page: Page) =>
  page.locator('[data-testid="save-banner"][data-kind="review"]');
const sheet = (page: Page) => page.getByTestId('merge-view');
const piece = (page: Page, block: string) =>
  sheet(page).locator(`[data-merge-piece="${block}"]`);

async function review(page: Page) {
  await strip(page).getByRole('button', { name: m.merge_review() }).click();
  await expect(sheet(page)).toBeVisible();
}

/** The collaboration mock as a server that is down (kept across reloads). */
async function setReachable(page: Page, reachable: boolean) {
  await page.evaluate(async (value) => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(value);
  }, reachable);
}

// Q251 with the 7-day rule: a group last edited over 7 days ago becomes
// pieces and is never applied raw.
test('an expired draft becomes pieces, never applied', async ({ page }) => {
  test.setTimeout(150_000);
  const editor = await openNote(page);
  // Offline edits the room never gets, left behind by a closed tab...
  await setOnline(page, false);
  await typeAtEnd(page, ' Old edit.');
  await expect.poll(() => storedKinds(page)).toContain('state');
  await setReachable(page, false);
  await setOnline(page, true);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
  // ...over 7 days ago.
  await page.evaluate(async (id) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { DRAFT_EXPIRY_MS, draftKey, putDrafts, readDrafts } = await import(
      draftsPath
    );
    const { user } = await import(dbPath);
    const key = draftKey(user.id, 'material', id);
    const rows: { savedAt: number }[] = await readDrafts(key);
    const old = Date.now() - DRAFT_EXPIRY_MS - 60_000;
    await putDrafts(rows.map((row) => ({ ...row, savedAt: old })));
  }, NOTE);
  await setReachable(page, true);
  await page.goto(note);
  await expect(strip(page)).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText(seed);
  await expect(editor).not.toContainText('Old edit.');
  await expect.poll(() => storedKinds(page)).toEqual(['piece']);
  await review(page);
  await expect(piece(page, INTRO)).toContainText('Old edit.');
  await expect(piece(page, INTRO)).toContainText(m.merge_source_expired());
});

/** Pieces the merge view shows, stored as a closed tab left them. */
async function storePieces(page: Page) {
  await page.evaluate(
    async ({ id, intro }) => {
      const draftsPath = '/src/lib/editDrafts.ts';
      const dbPath = '/src/mocks/db.ts';
      const rowsPath = '/src/features/notes/merge/pieceRows.ts';
      const { draftKey, putDrafts } = await import(draftsPath);
      const { user } = await import(dbPath);
      const { pieceRow } = await import(rowsPath);
      const key = draftKey(user.id, 'material', id);
      const lineage = `material:${id}:schema:1`;
      const paragraph = (block: string, text: string) => ({
        children: [{ text }],
        id: block,
        type: 'p',
      });
      await putDrafts([
        pieceRow(
          key,
          lineage,
          {
            after: null,
            at: Date.now(),
            block: intro,
            mine: paragraph(intro, 'Mine, from before.'),
            source: 'changed',
          },
          1
        ),
        pieceRow(
          key,
          lineage,
          {
            after: intro,
            at: Date.now(),
            block: 'mock-scenario-gone',
            mine: paragraph('mock-scenario-gone', 'A block someone deleted.'),
            source: 'refused',
          },
          1
        ),
      ]);
    },
    { id: NOTE, intro: INTRO }
  );
}

// Q229's first applied wins: a peer's edit landing as the user chooses
// leaves the note alone and asks for a fresh look.
test('a choice on a block that just changed applies nothing and says so', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const editor = await openNote(page);
  await storePieces(page);
  await page.reload();
  await expect(strip(page)).toBeVisible({ timeout: 30_000 });
  await review(page);
  const row = piece(page, INTRO);
  await row.getByRole('button').first().click();
  await joinPeer(page);
  // The peer's change and the click in one task: the sheet still shows the
  // block as it was.
  await page.evaluate(
    ({ intro, label }) => {
      const peer = (window as unknown as { peer: Peer }).peer;
      peer.replace(intro, {
        children: [{ text: 'Peer edit.' }],
        id: intro,
        type: 'p',
      });
      const apply = [
        ...document.querySelectorAll<HTMLButtonElement>(
          `[data-merge-piece="${intro}"] button`
        ),
      ].find((button) => button.textContent === label);
      apply?.click();
    },
    { intro: INTRO, label: m.merge_apply() }
  );
  await expect(row).toContainText(m.merge_stale());
  await expect(editor).toContainText('Peer edit.');
  await expect(editor).not.toContainText('Mine, from before.');
  // Looked at again, it applies.
  await row.getByRole('button', { name: m.merge_apply() }).click();
  await expect(editor).toContainText('Mine, from before.');
});

// Q237: typing the room never saw, in a block a co-editor deleted while the
// tab was offline, never shows; the reconnect's sync finds it and the merge
// view offers it back.
test('typing hidden in a block someone deleted comes back to restore', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const editor = await openNote(page);
  await joinPeer(page);
  // A second block, so the note keeps one when the intro goes.
  await page.evaluate(() =>
    (window as unknown as { peer: Peer }).peer.append([
      {
        children: [{ text: 'Second block.' }],
        id: 'mock-scenario-second',
        type: 'p',
      },
    ])
  );
  await expect(editor).toContainText('Second block.');
  await setOnline(page, false);
  await editor.getByText(seed).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed offline.');
  await page.evaluate(
    (intro) => (window as unknown as { peer: Peer }).peer.remove(intro),
    INTRO
  );
  await setOnline(page, true);
  await expect(strip(page)).toBeVisible({ timeout: 30_000 });
  await expect(editor).not.toContainText('Typed offline.');
  await review(page);
  const row = piece(page, INTRO);
  await expect(row).toHaveAttribute('data-status', 'theirs-deleted');
  await expect(row).toContainText('Typed offline.');
  await expect(row).toContainText(m.merge_source_hidden());
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: m.merge_restore() }).click();
  await expect(editor).toContainText('Typed offline.');
  // In the room: the peer reads it.
  await expect
    .poll(() =>
      page.evaluate(() =>
        String(
          (window as unknown as { peer: Peer }).peer.document.get('content')
        )
      )
    )
    .toContain('Typed offline.');
});

// Q255: a choice edits the note only while it is live and synced; a room
// swap's paused note keeps the sheet with its choices off.
test('the sheet stays through a room swap, its choices off while the note is paused', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const editor = await openNote(page);
  await storePieces(page);
  await page.reload();
  await expect(strip(page)).toBeVisible({ timeout: 30_000 });
  await review(page);
  const row = piece(page, INTRO);
  await row.getByRole('button').first().click();
  const apply = row.getByRole('button', { name: m.merge_apply() });
  await expect(apply).toBeEnabled();
  // The service discards the room and holds the next one's answer.
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { discardMockMaterialRoom, setCollaborationSlowed } = await import(
      path
    );
    setCollaborationSlowed(true);
    discardMockMaterialRoom(id);
  }, NOTE);
  await expect(page.locator('[data-note-mount="paused"]')).toBeVisible();
  await expect(apply).toBeDisabled();
  await expect(sheet(page)).toContainText(m.merge_reconnect());
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationSlowed } = await import(path);
    setCollaborationSlowed(false);
  });
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(editor).toContainText('Mine, from before.');
});

test('Discard drops every piece after a confirmation; Restore puts a deleted block back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const editor = await openNote(page);
  await storePieces(page);
  await page.reload();
  await expect(strip(page)).toBeVisible({ timeout: 30_000 });
  if (shots) {
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ height: 760, width });
      await page.screenshot({ path: `${shots}/strip-${width}.png` });
    }
  }
  await review(page);
  const gone = piece(page, 'mock-scenario-gone');
  await expect(gone).toHaveAttribute('data-status', 'theirs-deleted');
  await gone.getByRole('button').first().click();
  if (shots) {
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ height: 760, width });
      await page.screenshot({ path: `${shots}/sheet-${width}.png` });
    }
    await page.setViewportSize({ height: 720, width: 1280 });
  }
  await gone.getByRole('button', { name: m.merge_restore() }).click();
  await expect(editor).toContainText('A block someone deleted.');
  await expect(gone).toHaveAttribute('data-status', 'resolved');
  // The rest goes with Discard.
  await strip(page)
    .getByRole('button', { name: m.merge_discard_all() })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: m.merge_discard_confirm() })
    .click();
  await expect(strip(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  await expect(editor).toContainText(seed);
  await expect(editor).not.toContainText('Mine, from before.');
  await expect.poll(() => storedKinds(page)).toEqual([]);
});
