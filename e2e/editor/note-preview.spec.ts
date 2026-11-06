import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

/* Note Preview (Epo Q669 A, 2026-11-06): the editor stays mounted behind it and
 * Preview draws the readers' rendering from the live editor's text. Runs on a
 * note that keeps a device copy, where an unmount would come back on that copy. */

const NOTE = 'mock-scenario-note';
const SCENARIOS = `/workspaces/ws_scenarios?material=${NOTE}`;
const SEED = 'A note for trying application errors.';
const MATRIX = 'mat_note_bio_feature_matrix';

const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');
const preview = (page: Page) => page.getByTestId('material-preview');
const pressPreview = (page: Page) =>
  page
    .getByRole('button', { exact: true, name: m.editor_embed_preview() })
    .click();
const pressEdit = (page: Page) =>
  page.getByRole('button', { exact: true, name: m.action_edit() }).click();

const saved = (page: Page) =>
  expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );

/** The note's own requests from here on: a body read, a token, a channel. */
function watchReads(page: Page) {
  const reads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes(`/${NOTE}`))
      reads.push(request.url());
  });
  return reads;
}

const peerAppends = (page: Page, id: string, text: string) =>
  page.evaluate(
    async ([id, text]) => {
      const path = '/src/mocks/collaboration.ts';
      const { mockNotePeer } = await import(path);
      mockNotePeer('mock-scenario-note').append([
        { children: [{ text }], id, type: 'p' },
      ]);
    },
    [id, text]
  );

/** A peer's edit in the next room, once it has opened. */
const peerAppendsNext = (page: Page, id: string, text: string) =>
  expect(() => peerAppends(page, id, text)).toPass({ timeout: 30_000 });

const discardRoom = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { discardMockMaterialRoom } = await import(path);
    discardMockMaterialRoom('mock-scenario-note');
  });

async function typeIntoNote(page: Page, typed: string) {
  await page.goto(SCENARIOS);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await clickTextEnd(editable(page).getByText(SEED));
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
  await clickTextEnd(editable(page).getByText(SEED));
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
  const reads = watchReads(page);
  await pressPreview(page);
  await expect(preview(page)).toContainText('No read.');
  await pressEdit(page);
  await expect(editable(page)).toBeVisible();
  expect(reads).toEqual([]);
});

test("a collaborator's typing reaches an open Preview, with no read or room of its own", async ({
  page,
}) => {
  await typeIntoNote(page, ' Mine.');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Mine.');
  const reads = watchReads(page);
  await peerAppends(page, 'peer-line', 'Typed by a peer.');
  await expect(preview(page)).toContainText('Typed by a peer.');
  expect(reads).toEqual([]);
});

test('a room swap before Preview leaves it reading the next editor', async ({
  page,
}) => {
  await typeIntoNote(page, ' Before the swap.');
  await saved(page);
  await discardRoom(page);
  await expect(editable(page)).toContainText('Before the swap.', {
    timeout: 30_000,
  });
  await saved(page);
  await pressPreview(page);
  await expect(preview(page)).toContainText('Before the swap.');
  await peerAppendsNext(page, 'peer-after-swap', 'Peer in the next room.');
  await expect(preview(page)).toContainText('Peer in the next room.');
  await pressEdit(page);
  await clickTextEnd(editable(page).getByText('Before the swap.'));
  await page.keyboard.type(' On.');
  await expect(editable(page)).toContainText('Before the swap. On.');
});

test('a room swap during Preview hands it the next editor', async ({
  page,
}) => {
  await typeIntoNote(page, ' Before the swap.');
  await saved(page);
  await pressPreview(page);
  await expect(preview(page)).toContainText('Before the swap.');
  await discardRoom(page);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );
  await peerAppendsNext(page, 'peer-during-swap', 'Peer in the next room.');
  await expect(preview(page)).toContainText('Peer in the next room.', {
    timeout: 30_000,
  });
  await pressEdit(page);
  await expect(editable(page)).toContainText('Peer in the next room.');
});

test("a table's toolbar closes with Preview, so nothing there can edit the hidden note", async ({
  page,
}) => {
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  const cell = editable(page).getByText('Cytosol', { exact: true });
  await cell.scrollIntoViewIfNeeded();
  await clickTextEnd(cell);
  const remove = page.getByRole('button', { name: m.editor_delete_table() });
  await expect(remove).toBeVisible();
  await pressPreview(page);
  await expect(preview(page).locator('td').first()).toBeVisible();
  await expect(remove).toBeHidden();
  await pressEdit(page);
  // The caret comes back into the table, and with it its toolbar.
  await expect(remove).toBeVisible();
});

test("the editor's command palette stays shut in Preview", async ({ page }) => {
  await typeIntoNote(page, ' Palette.');
  const search = page.getByPlaceholder(m.editor_search_commands());
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Palette.');
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForTimeout(300);
  await expect(search).toBeHidden();
});

test("the caret follows a peer's edit in its block", async ({ page }) => {
  await typeIntoNote(page, ' Mine');
  await pressPreview(page);
  await expect(preview(page)).toContainText('Mine');
  // A collaborator types at the start of the caret's block.
  await page.evaluate(async (seed) => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = await import(path);
    const peer = mockNotePeer('mock-scenario-note');
    const root = peer.document.get('content');
    const block = root
      .toDelta()
      .map((op: { insert: { toString(): string } }) => op.insert)
      .find((insert: { toString(): string }) =>
        insert.toString().includes(seed)
      );
    block.insert(0, 'Peer: ');
  }, SEED);
  await expect(preview(page)).toContainText(`Peer: ${SEED}`);
  await pressEdit(page);
  await expect(editable(page)).toBeVisible();
  await page.keyboard.type(' again');
  await expect(editable(page)).toContainText(`Peer: ${SEED} Mine again`);
});

test('save strips stay on screen over Preview, and the button says so when the note is locked', async ({
  page,
}) => {
  await typeIntoNote(page, ' Strip.');
  await saved(page);
  await pressPreview(page);
  await expect(preview(page)).toContainText('Strip.');
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseThisBuild, setCollaborationReachable } = await import(path);
    setCollaborationReachable(false);
    refuseThisBuild();
    setCollaborationReachable(true);
  });
  const banner = page.locator(
    '[data-testid="save-banner"][data-kind="outdated"]'
  );
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { exact: true, name: m.note_preview_close() })
  ).toBeVisible();
});

test('an embed keeps its answer in Preview while a peer types', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await pressPreview(page);
  const answer = page.getByRole('button', { name: /Mitochondria/ }).first();
  await answer.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = await import(path);
    mockNotePeer(id).append([
      { children: [{ text: 'Peer below.' }], id: 'peer-below', type: 'p' },
    ]);
  }, MATRIX);
  await expect(preview(page)).toContainText('Peer below.');
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
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
  // A replayed flash ends on its own, so watch for it starting.
  await page.evaluate(() => {
    new MutationObserver((changes) => {
      if (
        changes.some(
          (change) =>
            change.target instanceof Element &&
            change.target.hasAttribute('data-citation-flash')
        )
      )
        Object.assign(window, { citationFlashed: true });
    }).observe(document.body, {
      attributeFilter: ['data-citation-flash'],
      subtree: true,
    });
  });
  await pressEdit(page);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(
    await page.evaluate(
      () => (window as { citationFlashed?: boolean }).citationFlashed
    )
  ).toBeUndefined();
});

/** The matrix note with its quiz embed's room open in the hidden editor. */
async function openNearEmbed(page: Page) {
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  const embed = page
    .locator('[data-note-mount="live"] .slate-material_ref')
    .first();
  await embed.scrollIntoViewIfNeeded();
  await expect(embed.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
}

function watchTokens(page: Page) {
  const tokens: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/collaboration-token'))
      tokens.push(request.url());
  });
  return tokens;
}

test("Preview shares an embed's room with the editor: no token or channel of its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openNearEmbed(page);
  await page.waitForTimeout(1500);
  const tokens = watchTokens(page);
  await pressPreview(page);
  const answer = preview(page)
    .getByRole('button', { name: /Mitochondria/ })
    .first();
  await expect(answer).toBeInViewport({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  expect(tokens).toEqual([]);
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
});

test('an embed the editor had open still answers in Preview offline', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (sessionStorage.getItem('e2e.reads.fail') && url.includes('/api/'))
        return Promise.reject(new TypeError('Failed to fetch'));
      return original(input, init);
    };
  });
  await openNearEmbed(page);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(false);
    sessionStorage.setItem('e2e.reads.fail', 'true');
  });
  await page.context().setOffline(true);
  await pressPreview(page);
  await expect(
    preview(page)
      .getByRole('button', { name: /Mitochondria/ })
      .first()
  ).toBeVisible({ timeout: 30_000 });
});

test('an embed that was never near opens one room, which the editor then shares', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/workspaces/ws_bio?material=${MATRIX}`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const tokens = watchTokens(page);
  await pressPreview(page);
  await expect(preview(page).locator('td').first()).toBeAttached();
  const answer = preview(page)
    .getByRole('button', { name: /Mitochondria/ })
    .first();
  await answer.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await expect(answer).toBeVisible();
  await page.waitForTimeout(1500);
  const quiz = () => tokens.filter((url) => url.includes('matrix_quiz'));
  expect(quiz()).toHaveLength(1);
  await pressEdit(page);
  const embed = page
    .locator('[data-note-mount="live"] .slate-material_ref')
    .first();
  await expect(embed.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  // Its content room is shared; only the keys room is new.
  await page.waitForTimeout(1500);
  expect(quiz()).toHaveLength(2);
});
