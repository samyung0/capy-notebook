import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The BlockSuite note offline on MSW (PE:97): it stays editable under the
 * offline strip with every edit stored on this device, its stored edits
 * outlive a reload, and once back the room and another participant (a
 * headless peer: MSW's rooms live in the page) converge with nothing lost.
 * Runs only with the flag on:
 * `VITE_DOCUMENT_LAYOUT=blocks pnpm e2e:msw:editor blocksuite-offline`.
 */

// biome-ignore lint/suspicious/noSkippedTests: BlockSuite notes exist only on a blocks-layout stack.
test.skip(
  process.env.VITE_DOCUMENT_LAYOUT !== 'blocks',
  'needs VITE_DOCUMENT_LAYOUT=blocks'
);

// The scenario note keeps its room and drafts across reloads (MSW stores
// mock-scenario fixtures for the tab).
const NOTE = 'mock-scenario-note';
const BLOCK = 'mock-scenario-note-intro';
const SEED = 'A note for trying application errors.';
const COLLABORATION = '/src/mocks/collaboration.ts';

async function openNote(page: Page) {
  await page.goto(`/workspaces/ws_scenarios?material=${NOTE}&mode=edit`);
  const note = page.locator('[data-blocksuite-note]');
  // The first open transforms BlockSuite's sources.
  await expect(note.getByText(SEED)).toBeVisible({ timeout: 45_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  return note;
}

const saveState = (page: Page) => page.getByTestId('editor-save-state');

/** Types at the end of the note's paragraph. */
async function type(page: Page, note: Locator, text: string) {
  const block = note.locator(`[data-block-id="${BLOCK}"] [contenteditable]`);
  const box = (await block.boundingBox())!;
  await block.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

// Chromium's offline emulation does not reliably fire the window events.
async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

/** The collaboration mock as a server that is down (kept across reloads). */
async function setReachable(page: Page, reachable: boolean) {
  await page.evaluate(
    async ({ path, value }) => {
      const { setCollaborationReachable } = await import(path);
      setCollaborationReachable(value);
    },
    { path: COLLABORATION, value: reachable }
  );
}

/** The kinds of the note's stored rows. */
async function draftKinds(page: Page) {
  return page.evaluate(async (note) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const rows: { kind: string }[] = await readDrafts(
      draftKey(user.id, 'material', note)
    );
    return rows.map((row) => row.kind);
  }, NOTE);
}

const storedDrafts = async (page: Page) => (await draftKinds(page)).length;

/** Types and waits for the receipt that deletes the rows: the room accepted
 * this session (Q326), so the edits it stores later reopen on this device. */
async function typeSaved(page: Page, note: Locator, text: string) {
  await type(page, note, text);
  await expect.poll(() => storedDrafts(page), { timeout: 15_000 }).toBe(0);
}

/** Another participant of the note's mock room, headless, on `window.peer`. */
async function joinPeer(page: Page) {
  await page.evaluate(
    async ({ id, path }) => {
      const { join, mockMaterialRoom, rooms } = (await import(
        path
      )) as typeof import('../../src/mocks/collaboration');
      const room = rooms.get(mockMaterialRoom(id))!;
      const Doc = room.document.constructor as new () => typeof room.document;
      const document = new Doc();
      join(room, { document, origin: {} });
      Object.assign(window, { peer: document });
    },
    { id: NOTE, path: COLLABORATION }
  );
}

type PeerDoc = import('yjs').Doc;

const peerText = (page: Page) =>
  page.evaluate((block) => {
    const { peer } = window as unknown as { peer: PeerDoc };
    const yBlock = peer.getMap('blocks').get(block) as
      | import('yjs').Map<unknown>
      | undefined;
    return yBlock?.get('prop:text')?.toString();
  }, BLOCK);

test('offline typing stays editable, is stored, and converges with a peer once back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const note = await openNote(page);
  await typeSaved(page, note, ' Saved first.');
  await joinPeer(page);

  await setOnline(page, false);
  await expect(
    page.locator('[data-testid="save-banner"][data-kind="offline"]')
  ).toBeVisible();
  // The header's connection status takes the save state's place.
  await expect(
    page.locator('[data-connection-status="offline"]')
  ).toBeVisible();
  await type(page, note, ' Written offline.');
  await expect(note.getByText('Saved first. Written offline.')).toBeVisible();
  // One update row per key, and the whole note once for the episode.
  const kinds = await draftKinds(page);
  expect(kinds.filter((kind) => kind === 'state')).toHaveLength(1);
  expect(kinds.filter((kind) => kind === 'update').length).toBeGreaterThan(1);
  // The peer writes meanwhile; the room holds it, the tab not yet.
  await page.evaluate((block) => {
    const { peer } = window as unknown as { peer: PeerDoc };
    const yBlock = peer.getMap('blocks').get(block) as import('yjs').Map<
      import('yjs').Text
    >;
    yBlock.get('prop:text')!.insert(0, 'Peer: ');
  }, BLOCK);
  expect(await peerText(page)).toBe(`Peer: ${SEED} Saved first.`);

  await setOnline(page, true);
  const both = `Peer: ${SEED} Saved first. Written offline.`;
  await expect(note.getByText(both)).toBeVisible();
  await expect.poll(() => peerText(page)).toBe(both);
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await expect(page.getByTestId('save-banner')).toHaveCount(0);
  // The receipt deleted what it covered.
  await expect.poll(() => storedDrafts(page)).toBe(0);
});

test('offline edits outlive a reload and save once the room is back', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const note = await openNote(page);
  await typeSaved(page, note, ' Saved first.');
  await setOnline(page, false);
  await type(page, note, ' Written offline.');
  await expect.poll(() => storedDrafts(page)).toBeGreaterThan(1);

  // Back online while the service stays unreachable, then reload: the
  // edits come back from this device, not from the room.
  await setReachable(page, false);
  await setOnline(page, true);
  await page.reload();
  await expect(saveState(page)).toHaveAttribute(
    'data-save-state',
    'connecting',
    { timeout: 30_000 }
  );
  await setReachable(page, true);
  await expect(
    page
      .locator('[data-blocksuite-note]')
      .getByText(`${SEED} Saved first. Written offline.`)
  ).toBeVisible({ timeout: 45_000 });
  await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
  await expect.poll(() => storedDrafts(page)).toBe(0);

  // Stored by the room: a reload with nothing on this device shows it.
  await page.reload();
  await expect(
    page
      .locator('[data-blocksuite-note]')
      .getByText(`${SEED} Saved first. Written offline.`)
  ).toBeVisible({ timeout: 45_000 });
});
