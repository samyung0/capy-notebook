import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// The late path (in-place GC): a tab away past the room's collection window
// is answered late when it comes back. Its editor stays on screen paused, a
// new editor fetches the current note, the Rust merge (WASM, in a worker)
// places the tab's unsent edits onto it, and the new editor swaps in with
// every word once. The scenario note keeps its room and drafts (MSW).
const MATERIAL = 'mock-scenario-note';
const note = `/workspaces/ws_scenarios?material=${MATERIAL}&mode=edit`;
const seed = 'A note for trying application errors.';
const OFFLINE = ' Written while away.';
const PEER = 'A block from another tab.';
const AGAIN = ' Typed after the merge.';

const MOCK = '/src/mocks/collaboration.ts';

async function setReachable(page: Page, reachable: boolean) {
  await page.evaluate(
    async ({ path, value }) => {
      const { setCollaborationReachable } = await import(path);
      setCollaborationReachable(value);
    },
    { path: MOCK, value: reachable }
  );
}

async function lateSessions(
  page: Page,
  materialId: string | null,
  every = false
) {
  await page.evaluate(
    async ({ all, path, value }) => {
      const collaboration = await import(path);
      collaboration.lateSessions(value, all);
    },
    { all: every, path: MOCK, value: materialId }
  );
}

/** Another tab in the note's room (left on `window` for later steps). */
async function joinPeer(page: Page) {
  await page.evaluate(
    async ({ path, value }) => {
      const { mockNotePeer } = await import(path);
      Object.assign(window, { latePeer: mockNotePeer(value) });
    },
    { path: MOCK, value: MATERIAL }
  );
}

async function peerAppends(page: Page, text: string) {
  await page.evaluate((value) => {
    const { latePeer } = window as unknown as {
      latePeer: { append: (blocks: unknown[]) => void };
    };
    latePeer.append([
      { children: [{ text: value }], id: 'late-peer', type: 'p' },
    ]);
  }, text);
}

/** The scenario room's text now (null while no room is open). */
function roomText(page: Page) {
  return page.evaluate(
    async ({ path, value }) => {
      const { mockNoteRoomText } = await import(path);
      return mockNoteRoomText(value) as string | null;
    },
    { path: MOCK, value: MATERIAL }
  );
}

/** The JOIN versions and late-merge marks the note's sessions named (the
 * mock provider records them; in-place GC). */
function sessionVersions(page: Page) {
  return page.evaluate(
    async ({ path, value }) => {
      const { mockSessionVersions } = await import(path);
      return mockSessionVersions(value) as {
        joins: (number | null)[];
        marks: number[];
      };
    },
    { path: MOCK, value: MATERIAL }
  );
}

/** Every late merge's request waits in the page until the test calls
 * `releaseLateMerge` (never, for a merge that must run out of time). */
async function holdMerges(page: Page) {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('lateMerge.worker')) return;
        const post = this.postMessage.bind(this);
        this.postMessage = (...args: Parameters<Worker['postMessage']>) => {
          Object.assign(window, { releaseLateMerge: () => post(...args) });
        };
      }
    };
  });
}

/** Every late merge fails once its request is posted, as a merge that
 * errors after its code loaded. */
async function failMerges(page: Page) {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('lateMerge.worker')) return;
        this.postMessage = () =>
          setTimeout(() =>
            this.onmessage?.(
              new MessageEvent('message', { data: { error: 'e2e failure' } })
            )
          );
      }
    };
  });
}

/** The merge view's strip, and its sheet once Review opened it (Q420: a
 * note's edits a late merge could not place wait there, on the live note). */
const reviewStrip = (page: Page) =>
  page.locator('[data-testid="save-banner"][data-kind="review"]');

async function review(page: Page) {
  await reviewStrip(page)
    .getByRole('button', { name: m.merge_review() })
    .click();
  const sheet = page.getByTestId('merge-view');
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Once the new session joined, its room lacks the offline words: the
 * stored late rows wait for the merge, never applied raw. */
async function roomLacksOfflineWords(page: Page) {
  await expect.poll(() => roomText(page), { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(1000);
  expect(await roomText(page)).not.toContain(OFFLINE.trim());
}

function mergeHeld(page: Page) {
  return page.waitForFunction(() => 'releaseLateMerge' in window, undefined, {
    timeout: 30_000,
  });
}

async function peerRemovesFirstBlock(page: Page) {
  await page.evaluate(() => {
    const { latePeer } = window as unknown as {
      latePeer: { remove: (index: number) => void };
    };
    latePeer.remove(0);
  });
}

async function peerLeaves(page: Page) {
  await page.evaluate(() => {
    const { latePeer } = window as unknown as {
      latePeer: { leave: () => void };
    };
    latePeer.leave();
  });
}

/** Holds the late merge's WASM download until `answer` aborts it or lets it
 * through (a route disables the page's HTTP cache). */
// Chromium's offline emulation does not reliably fire the window events.
async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

/** The note's stored draft rows in this browser, by id. */
function storedRows(page: Page) {
  return page.evaluate(async (id) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const rows: {
      id: string;
      late?: true;
      refused?: true;
      session: string;
    }[] = await readDrafts(draftKey(user.id, 'material', id));
    return rows
      .map(({ id: row, late, refused, session }) => ({
        id: row,
        late: !!late,
        refused: !!refused,
        session,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }, MATERIAL);
}

async function holdDownload(page: Page) {
  let answer: (how: 'abort' | 'continue') => void = () => {};
  const answered = new Promise<'abort' | 'continue'>((resolve) => {
    answer = resolve;
  });
  await page.context().route('**/late_merge_bg.wasm*', async (route) => {
    if ((await answered) === 'abort') await route.abort('failed');
    else await route.continue();
  });
  return (how: 'abort' | 'continue') => answer(how);
}

test('a late tab merges its unsent edits into the current note and swaps without losing or doubling text', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');

  // Another tab stays in the room while this one loses it and edits.
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);

  // The room collected past this session: its rejoin is answered late, and
  // only a new session joins. Until the merge's code loaded nothing is
  // marked; the mark is taken then (Q406, review r2 S6).
  const download = await holdDownload(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing', {
    timeout: 30_000,
  });
  await page.waitForTimeout(1000);
  expect((await sessionVersions(page)).marks).toEqual([]);
  download('continue');
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  const versions = await sessionVersions(page);
  // Marked as the code loaded, and again at that version as the result
  // applied (review r4 L1).
  expect(versions.marks).toHaveLength(2);
  expect(versions.marks[1]).toBe(versions.marks[0]);
  // The late mount joined as a new session, naming no version.
  expect(versions.joins.length).toBeGreaterThan(1);
  expect(versions.joins.at(-1)).toBeNull();
  const editor = live.locator('[contenteditable="true"]');
  // One swap, at the merged note: the caret and the focus came back
  // (review r3 L2).
  await expect(editor).toBeFocused();
  await expect(editor).toContainText(PEER);
  await expect(editor).toContainText(OFFLINE.trim());
  await expect(page.locator('[data-note-mount]')).toHaveCount(1);
  expect(workers.some((url) => url.includes('lateMerge.worker'))).toBe(true);
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(PEER).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });

  // A new session: its Undo holds nothing, so Ctrl+Z keeps the merged words.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText(OFFLINE.trim());

  // Cut off again after the merge and answered late once more: this session
  // is late as any, and what it typed since is merged in turn.
  await setReachable(page, false);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(AGAIN);
  await setReachable(page, true);
  await expect(editor).toContainText(AGAIN.trim(), { timeout: 30_000 });
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(reviewStrip(page)).toHaveCount(0);
  const again = await editor.innerText();
  expect(again.split(AGAIN.trim()).length - 1).toBe(1);
  expect(again.split(OFFLINE.trim()).length - 1).toBe(1);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });

  // The room holds them: a reload shows each, once.
  await lateSessions(page, null);
  await peerLeaves(page);
  await page.reload();
  const reloaded = page.locator('[contenteditable="true"]').first();
  await expect(reloaded).toContainText(PEER, { timeout: 30_000 });
  const after = await reloaded.innerText();
  expect(after.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(after.split(AGAIN.trim()).length - 1).toBe(1);
});

// Q295, Q398: while the merge's code downloads (no time limit) the note
// shows the tab's own copy read-only (the paused note beside the late mount)
// and the header reads Getting ready; a failed download shows the own copy
// in the late mount with a strip offering Retry, everything kept, and a
// reconnecting browser tries again too.
test('a late tab shows its own copy while the merge code downloads; a failed download retries on Retry and on reconnect', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);

  let download = await holdDownload(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  const paused = page.locator('[data-note-mount="paused"]');
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing', {
    timeout: 30_000,
  });
  await expect(paused).toContainText(OFFLINE.trim());
  await expect(live).toHaveCount(0);
  // The paused note is the copy: the late mount beside it renders none.
  await expect(page.getByTestId('late-copy')).toHaveCount(0);
  // Past the merge's 10 s: the download has no limit.
  await page.waitForTimeout(11_000);
  await expect(paused).toContainText(OFFLINE.trim());
  await expect(reviewStrip(page)).toHaveCount(0);

  // The download fails: the late mount shows the own copy, everything kept,
  // with Retry.
  download('abort');
  const banner = page.locator(
    '[data-testid="save-banner"][data-kind="late-unloaded"]'
  );
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const copy = live.getByTestId('late-copy');
  await expect(copy).toContainText(OFFLINE.trim());
  await expect(live.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('[data-note-toolbar]')).toHaveAttribute(
    'inert',
    ''
  );
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing');
  await expect(reviewStrip(page)).toHaveCount(0);

  // One strip at a time: offline ranks above the failed download, whose
  // strip comes back with the connection (Q420). This session rejoins as
  // any (the mock would answer every session that joined before late).
  await lateSessions(page, null);
  await setOnline(page, false);
  await expect(
    page.locator('[data-testid="save-banner"][data-kind="offline"]')
  ).toBeVisible({ timeout: 30_000 });
  await expect(banner).toHaveCount(0);
  await setOnline(page, true);
  await expect(banner).toBeVisible({ timeout: 30_000 });

  // Retry fails again, then the browser reconnects and it goes through.
  await page.context().unroute('**/late_merge_bg.wasm*');
  download = await holdDownload(page);
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toHaveCount(0);
  download('abort');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await page.context().unroute('**/late_merge_bg.wasm*');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const editor = live.locator('[contenteditable="true"]');
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(banner).toHaveCount(0);
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await lateSessions(page, null);
});

// Q420: a late merge that fails opens the live note with the edits as the
// merge view's pieces, never dropping them.
test('a late merge that cannot finish keeps the edits as pieces on the live note, never dropping them', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await failMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(seed);
  await expect(editor).not.toContainText(OFFLINE.trim());
  const sheet = await review(page);
  await expect(sheet).toContainText(OFFLINE.trim());
  await expect(sheet).toContainText(m.merge_source_refused());
  // Kept on this device across a reload, still as pieces.
  await lateSessions(page, null);
  await page.reload();
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  await expect(await review(page)).toContainText(OFFLINE.trim());
});

test('a reload during the merge keeps the edits: the reloaded editor merges its stored late row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  // Another tab changes the note meanwhile and leaves, so the room stores
  // it (the mock room keeps its document across a reload only once stored);
  // the new session's first sync changes the value.
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);
  await peerLeaves(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await roomLacksOfflineWords(page);
  await mergeHeld(page);
  // A peer edits while the merge waits; past the checkpoint debounce no
  // receipt may have dropped the row.
  await joinPeer(page);
  await peerAppends(page, 'A block typed during the merge.');
  await page.waitForTimeout(2500);

  // The reloaded page joins (a new session); only the stored late row holds
  // the words, and it is merged, never applied raw: the room lacks them
  // while the merge waits, and the toolbar takes no edit meanwhile.
  await page.reload();
  await roomLacksOfflineWords(page);
  await mergeHeld(page);
  await expect(page.locator('[data-note-toolbar]')).toHaveAttribute(
    'inert',
    ''
  );
  // Nothing paused shows it here: the opening mount shows the own copy
  // (Q295).
  await expect(
    page.locator('[data-note-mount="live"]').getByTestId('late-copy')
  ).toContainText(OFFLINE.trim());
  await page.evaluate(() =>
    (window as unknown as { releaseLateMerge: () => void }).releaseLateMerge()
  );
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(editor).toContainText(PEER);
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
});

test('a merge past its deadline keeps the edits as pieces on the live note', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  // The merge never answers: 10 s after its WASM loaded the tab stops it.
  await mergeHeld(page);
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  await expect(await review(page)).toContainText(OFFLINE.trim());
  await lateSessions(page, null);
});

test('text typed into a block another tab deleted waits as hidden typing in the merge view after the merge', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  // This tab types into the note's only block while cut off; another tab
  // adds a block, deletes that one and leaves (the room stores it).
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);
  await peerRemovesFirstBlock(page);
  await peerLeaves(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  // The merge applies, and the block holding the typed words, which its
  // deletion would hide, waits in the merge view as hidden typing (Q237,
  // Q420); the live note shows the other tab's block.
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(PEER);
  await expect(editor).not.toContainText(OFFLINE.trim());
  const sheet = await review(page);
  await expect(sheet).toContainText(OFFLINE.trim());
  await expect(sheet).toContainText(m.merge_source_hidden());
  // Kept on this device: a page reload shows it again.
  await lateSessions(page, null);
  await page.reload();
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  await expect(await review(page)).toContainText(OFFLINE.trim());
});

test('a merge that runs out of time after its editor stopped leaves the edits to the reloaded editor', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  // As in the reload case, a peer's block makes the room store the note.
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await peerAppends(page, PEER);
  await peerLeaves(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await mergeHeld(page);
  // Capy is updated meanwhile: the merging editor stops (outdated), and its
  // merge runs out of time afterwards. It leaves the stored rows alone.
  await page.evaluate(async (path) => {
    const { refuseThisBuild } = await import(path);
    refuseThisBuild();
  }, MOCK);
  await page.waitForTimeout(11_000);
  await expect(reviewStrip(page)).toHaveCount(0);
  // The reload (the new build) merges the stored late row.
  await page.reload();
  await mergeHeld(page);
  await page.evaluate(() =>
    (window as unknown as { releaseLateMerge: () => void }).releaseLateMerge()
  );
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(editor).toContainText(PEER);
  await expect(reviewStrip(page)).toHaveCount(0);
});

const HELD = ' Held steps.';
const DRAFTS_ANSWER = 'e2e.late.drafts.answer';
const DRAFTS_SENT = 'e2e.late.drafts.sent';

/** The service's `/drafts` for this tab (the mock token's URL is not
 * fetchable): a service that is down, or one answering `late` once
 * `answerDraftsLate` was called, or admitting every group into the note's
 * mock room (`answerDraftsClean`, Q436). The page's sweep, which sends with
 * the document's lock held exclusively, always meets a down service; only
 * the editor's sends get the answer and are counted (`draftSends`). */
async function serveDrafts(page: Page) {
  await page.addInitScript(
    ([answerKey, sentKey, mock, material]) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith('/drafts')) return original(input, init);
        const { held = [] } = await navigator.locks.query();
        const sweep = held.some(
          (lock) =>
            lock.mode === 'exclusive' && lock.name?.startsWith('capy-drafts:')
        );
        if (!sweep)
          sessionStorage.setItem(
            sentKey,
            String(Number(sessionStorage.getItem(sentKey) ?? 0) + 1)
          );
        const answer = sweep ? null : sessionStorage.getItem(answerKey);
        if (answer === 'late')
          return Response.json({ class: 'late' }, { status: 409 });
        if (answer === 'clean') {
          const { admitMockNoteDrafts } = await import(mock);
          admitMockNoteDrafts(material, init?.body as Uint8Array);
          return Response.json({});
        }
        throw new TypeError('Failed to fetch');
      };
    },
    [DRAFTS_ANSWER, DRAFTS_SENT, MOCK, MATERIAL]
  );
}

function answerDraftsClean(page: Page) {
  return page.evaluate(
    (key) => sessionStorage.setItem(key, 'clean'),
    DRAFTS_ANSWER
  );
}

function answerDraftsLate(page: Page) {
  return page.evaluate(
    (key) => sessionStorage.setItem(key, 'late'),
    DRAFTS_ANSWER
  );
}

const draftSends = (page: Page) =>
  page.evaluate((key) => Number(sessionStorage.getItem(key) ?? 0), DRAFTS_SENT);

/** Leaves the note with steps the room never took, as a closed session's
 * with its stored token (pending: the draft send's), on the workspace page
 * with the service down. */
async function leaveHeldSteps(page: Page) {
  await page.goto(note);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await setReachable(page, false);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(HELD);
  await page.goto('/workspaces/ws_scenarios');
  await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
  // As a real session's rows, they carry its stored token (the mock's
  // provider takes none).
  await page.evaluate(async (id) => {
    const draftsPath = '/src/lib/editDrafts.ts';
    const dbPath = '/src/mocks/db.ts';
    const { draftKey, putDrafts, readDrafts } = await import(draftsPath);
    const { user } = await import(dbPath);
    const key = draftKey(user.id, 'material', id);
    const rows: { grants?: string[] }[] = await readDrafts(key);
    if (!rows.length) throw new Error('No stored steps');
    await putDrafts(rows.map((row) => ({ ...row, grants: ['stored-token'] })));
  }, MATERIAL);
}

/** The note opened over the held steps: the draft send takes them (down)
 * while the note joins, synced and view-only. */
async function openOverHeldSteps(page: Page) {
  await page.goto(note);
  await setReachable(page, true);
  const content = page.locator('[data-slate-editor]').first();
  await expect(content).toContainText(seed, { timeout: 30_000 });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'syncing'
  );
  await expect(content).not.toContainText(HELD.trim());
  await expect.poll(() => draftSends(page)).toBeGreaterThan(0);
}

// Q406 (review r3 M1): a late mount merges every leftover draft with its
// own in one pass, a never-accepted session's pending steps included: none
// goes raw or through the draft send meanwhile.
test('a late tab merges the pending steps of another session with its own, in one merge', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await openOverHeldSteps(page);
  // This session is answered late before the send's 30 s hold.
  const download = await holdDownload(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, false);
  const sent = await draftSends(page);
  await setReachable(page, true);
  // The late mount tries its rows once as ordinary drafts (Q436; the
  // service is down here), then sends none while the merge's code downloads.
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'preparing',
    { timeout: 30_000 }
  );
  await page.waitForTimeout(3000);
  expect(await draftSends(page)).toBe(sent + 1);
  download('continue');
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(HELD.trim(), { timeout: 20_000 });
  const text = await editor.innerText();
  expect(text.split(HELD.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  expect(await draftSends(page)).toBe(sent + 1);
  await expect(reviewStrip(page)).toHaveCount(0);
  await lateSessions(page, null);
});

// Q406 (review r3 M1), Q420: a late merge that fails keeps every draft it
// took, the pending steps of another session included, as pieces.
test('a failed late merge keeps the pending steps it took as pieces', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await failMerges(page);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await openOverHeldSteps(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, false);
  await setReachable(page, true);
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  await expect(await review(page)).toContainText(HELD.trim());
  await lateSessions(page, null);
  await page.reload();
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  await expect(await review(page)).toContainText(HELD.trim());
});

// Q406 (review r3 M2): a draft send answered late (its steps older than the
// window) starts the late merge in the same session: the steps show live.
test('a draft send answered late merges its steps in the same session', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await serveDrafts(page);
  await leaveHeldSteps(page);
  await answerDraftsLate(page);
  await page.goto(note);
  await setReachable(page, true);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(HELD.trim(), { timeout: 25_000 });
  const text = await editor.innerText();
  expect(text.split(HELD.trim()).length - 1).toBe(1);
  await expect(reviewStrip(page)).toHaveCount(0);
});

// Review r3 L1: a merge whose mark another send took and a store cleared
// (the session reports past its base) runs again, marked anew.
test('a late merge runs again when its mark no longer holds the session at its base', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await holdMerges(page);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await mergeHeld(page);
  const [base] = (await sessionVersions(page)).marks;
  await page.evaluate(
    async ({ path, value, version }) => {
      const { setMockReportedVersion } = await import(path);
      setMockReportedVersion(value, version);
    },
    { path: MOCK, value: MATERIAL, version: base + 1 }
  );
  await page.evaluate(() =>
    (window as unknown as { releaseLateMerge: () => void }).releaseLateMerge()
  );
  await expect
    .poll(async () => (await sessionVersions(page)).marks)
    .toEqual([base, base + 1]);
  await page.evaluate(() =>
    (window as unknown as { releaseLateMerge: () => void }).releaseLateMerge()
  );
  const editor = live.locator('[contenteditable="true"]');
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  await lateSessions(page, null);
});

// Review r3 L4: leaving the note while the merge's code downloads stops its
// worker.
test('leaving a late note stops its merge worker', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await holdDownload(page);
  const started = page.waitForEvent('worker', {
    predicate: (worker) => worker.url().includes('lateMerge.worker'),
    timeout: 30_000,
  });
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  const worker = await started;
  const closed = new Promise<void>((resolve) =>
    worker.on('close', () => resolve())
  );
  await page.getByRole('link', { name: 'Scenario source.txt' }).click();
  await expect(page).toHaveURL(/file=mock-scenario-text/);
  await Promise.race([
    closed,
    page.waitForTimeout(10_000).then(() => {
      throw new Error('The merge worker outlived its editor');
    }),
  ]);
  await lateSessions(page, null);
});

// Q420 (review r4 M1): a room eviction while the late merge waits touches no
// draft row; the reopened note takes the late path again and merges them.
test('an eviction while the late merge waits keeps every draft for the reopened note', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  const download = await holdDownload(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await storedRows(page)).some((row) => row.late))
    .toBe(true);
  const before = await storedRows(page);
  const joins = (await sessionVersions(page)).joins.length;
  await page.evaluate(async (path) => {
    const { rejectMockNoteUpdate } = await import(path);
    rejectMockNoteUpdate('mock-scenario-note');
  }, MOCK);
  // The note reopens (a new session joins) and waits for the merge again.
  await expect
    .poll(async () => (await sessionVersions(page)).joins.length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(joins);
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing', {
    timeout: 30_000,
  });
  expect(await storedRows(page)).toEqual(before);
  await expect(reviewStrip(page)).toHaveCount(0);
  download('continue');
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  await expect(reviewStrip(page)).toHaveCount(0);
  await lateSessions(page, null);
});

// Q420 (review r4 M2): another open tab's rows (its session's lock held)
// stay out of a late tab's merge, stored as they were.
test("a late merge leaves another open tab's draft rows alone", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const OTHER = ' Typed in another tab.';
  const open = async (tab: Page) => {
    await tab.goto(note);
    await expect(
      tab.locator('[data-note-mount="live"] [contenteditable="true"]')
    ).toContainText(seed, { timeout: 30_000 });
    await expect(tab.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved'
    );
  };
  await open(page);
  const other = await page.context().newPage();
  try {
    await open(other);
    const mine = new Set((await storedRows(page)).map((row) => row.id));
    await setReachable(other, false);
    await other
      .locator('[data-note-mount="live"] [contenteditable="true"]')
      .click();
    await other.keyboard.press('ControlOrMeta+End');
    await other.keyboard.type(OTHER);
    await expect
      .poll(
        async () =>
          (await storedRows(other)).filter((row) => !mine.has(row.id)).length
      )
      .toBeGreaterThan(0);
    const theirs = (await storedRows(other)).filter((row) => !mine.has(row.id));

    await page.bringToFront();
    await setReachable(page, false);
    const live = page.locator('[data-note-mount="live"]');
    await live.locator('[contenteditable="true"]').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(OFFLINE);
    await lateSessions(page, MATERIAL);
    await setReachable(page, true);
    const editor = live.locator('[contenteditable="true"]');
    await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
    await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(reviewStrip(page)).toHaveCount(0);
    await expect(editor).not.toContainText(OTHER.trim());
    const after = await storedRows(page);
    for (const row of theirs) expect(after).toContainEqual(row);
    await lateSessions(page, null);
  } finally {
    await other.close();
  }
});

// Q426: the room turning read-only (a frozen account, storage full) while
// the late merge waits keeps every draft row; the next open that can write
// merges them.
test('a room turned read-only while the late merge waits keeps every draft for the next open', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  const download = await holdDownload(page);
  await lateSessions(page, MATERIAL);
  await setReachable(page, true);
  await expect(saveState).toHaveAttribute('data-save-state', 'preparing', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await storedRows(page)).some((row) => row.late))
    .toBe(true);
  const before = await storedRows(page);
  await page.evaluate(async (path) => {
    const { announceReadOnly } = await import(path);
    announceReadOnly();
  }, MOCK);
  // The note drops to View, every row kept.
  await expect(page.getByTestId('material-preview')).toBeVisible({
    timeout: 30_000,
  });
  expect(await storedRows(page)).toEqual(before);
  // The account can write again: the next open merges the words, once.
  download('continue');
  await page.goto(note);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  await expect(reviewStrip(page)).toHaveCount(0);
});

/** Cuts the tab off, types the offline words, and has the room answer this
 * session late once it is back (a peer keeps the mock room open). */
async function goLateWithOfflineWords(page: Page) {
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  await expect(live.locator('[contenteditable="true"]')).toContainText(seed, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved'
  );
  await joinPeer(page);
  await setReachable(page, false);
  await live.locator('[contenteditable="true"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
}

// Q436: a late tab's rows go once as ordinary drafts before any merge code:
// the service admits a group naming nothing it collected, and the note opens
// afresh (a new session, the merge's code never fetched), every word once.
test('a late tab whose drafts the service admits clean opens afresh with no merge code', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await serveDrafts(page);
  await goLateWithOfflineWords(page);
  await answerDraftsClean(page);
  await setReachable(page, true);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  expect(await draftSends(page)).toBe(1);
  expect(workers.some((url) => url.includes('lateMerge.worker'))).toBe(false);
  expect((await storedRows(page)).some((row) => row.late)).toBe(false);
  await expect(reviewStrip(page)).toHaveCount(0);
  await lateSessions(page, null);
});

// Q436: a group the service answers late (it names a collected unit) goes to
// the in-browser merge, which places the words once.
test('a late tab whose drafts the service answers late runs the merge', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await serveDrafts(page);
  await goLateWithOfflineWords(page);
  await answerDraftsLate(page);
  await setReachable(page, true);
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  expect((await editor.innerText()).split(OFFLINE.trim()).length - 1).toBe(1);
  expect(await draftSends(page)).toBe(1);
  expect(workers.some((url) => url.includes('lateMerge.worker'))).toBe(true);
  await expect(reviewStrip(page)).toHaveCount(0);
  await lateSessions(page, null);
});

// Q406 (merge view phase 2): a merged update the service refuses for an id
// it never recorded (`unassigned`, on entry: the room never holds it) is
// written anew under the new tab's own id, once: a second merge, the words
// once, live, with no pieces.
test("a late merge refused for an unrecorded id is re-authored under the tab's own id", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(note);
  const live = page.locator('[data-note-mount="live"]');
  const editor = live.locator('[contenteditable="true"]');
  await expect(editor).toContainText(seed, { timeout: 30_000 });
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved');
  await setReachable(page, false);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(OFFLINE);
  await lateSessions(page, MATERIAL);
  // The first merge's update is refused.
  await page.evaluate(async (path) => {
    const { refuseNextMockNoteUpdate } = await import(path);
    refuseNextMockNoteUpdate('mock-scenario-note', 'unassigned');
  }, MOCK);
  await setReachable(page, true);
  const merges = () =>
    workers.filter((url) => url.includes('lateMerge.worker')).length;
  // A new editor merges the old document again, under its own id.
  await expect.poll(merges, { timeout: 30_000 }).toBe(2);
  await expect(page.locator('[data-note-mount="paused"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(editor).toContainText(OFFLINE.trim(), { timeout: 30_000 });
  const text = await editor.innerText();
  expect(text.split(OFFLINE.trim()).length - 1).toBe(1);
  expect(text.split(seed).length - 1).toBe(1);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await expect(reviewStrip(page)).toHaveCount(0);
  // Typing goes on under that id: the room takes it and it saves.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(AGAIN);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 30_000,
  });
  await expect.poll(() => roomText(page)).toContain(AGAIN.trim());
  await lateSessions(page, null);
});

// Q413: a late tab's own edits past the 7-day expiry never merge: the next
// open shows them as expired pieces on the live note.
test("a late tab's own edits past the expiry become pieces instead of merging", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.clock.install();
  await goLateWithOfflineWords(page);
  await expect
    .poll(async () => (await storedRows(page)).length)
    .toBeGreaterThan(0);
  // Eight days on, as a sleeping device wakes (no timer runs between).
  await page.clock.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  await setReachable(page, true);
  await expect(reviewStrip(page)).toBeVisible({ timeout: 30_000 });
  const editor = page.locator(
    '[data-note-mount="live"] [contenteditable="true"]'
  );
  await expect(editor).not.toContainText(OFFLINE.trim());
  const sheet = await review(page);
  await expect(sheet).toContainText(OFFLINE.trim());
  await expect(sheet).toContainText(m.merge_source_expired());
  expect(workers.some((url) => url.includes('lateMerge.worker'))).toBe(false);
  await lateSessions(page, null);
});
