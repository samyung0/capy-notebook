import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';
import { clickTextEnd } from './helpers';

// Epo 2026-11-05: a room refusing someone leaves the page as it is: an editor
// goes read-only under a strip saying so. Only a refused read ends what shows.
const refuseRooms = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { refuseOpenRooms } = await import(path);
    return refuseOpenRooms() as number;
  });

const lowerRooms = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { announceReadOnly } = await import(path);
    return announceReadOnly() as number;
  });

/** This person lowered to viewer in the workspace (`demoteMockMember`; with
 * `notice` false, main's order: no role-change notice reads the workspace).
 * Returns how many item rooms closed. */
const demoteMember = (page: Page, workspaceId: string, notice = true) =>
  page.evaluate(
    async ([id, withNotice]) => {
      const path = '/src/mocks/collaboration.ts';
      const { demoteMockMember } = await import(path);
      return demoteMockMember(id, withNotice) as number;
    },
    [workspaceId, notice] as const
  );

const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');

/** The lost-access toast (Epo 2026-11-20), apart from the strip. */
const kickedToast = (page: Page) =>
  page.getByRole('alert').filter({ hasText: m.editor_access_lost() });

type ReadKey = readonly [string, string];

/** When the page's read of an item last settled (answered or refused), or 0
 * while one is under way. */
const readSettled = (page: Page, key: ReadKey) =>
  page.evaluate(async (queryKey) => {
    const path = '/src/api/queryClient.ts';
    const { queryClient } = await import(path);
    const state = queryClient.getQueryState(queryKey);
    return state?.fetchStatus === 'idle'
      ? Math.max(state.dataUpdatedAt, state.errorUpdatedAt)
      : 0;
  }, key);

/** The access-lost strip over the page, once the read the refusal asked for
 * (`before`: when it last settled) answered: no toast. */
async function expectStrip(page: Page, key: ReadKey, before: number) {
  await expect(page.getByText(m.editor_access_lost())).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => readSettled(page, key), { timeout: 15_000 })
    .toBeGreaterThan(before);
  await expect(page.getByText(m.error_not_found_title())).toHaveCount(0);
  await expect(page.getByText(m.error_file_title())).toHaveCount(0);
  await expect(kickedToast(page)).toHaveCount(0);
}

// Set to a folder to keep a screenshot of the unavailable page with the
// toast and the Files panel without the item.
const shots = process.env.ACCESS_LOST_SCREENSHOTS;

const SCENARIOS = '/workspaces/ws_scenarios?material=';
const QUIZ = '/workspaces/ws_bio?material=qz_bio_near';
const CARDS = `${SCENARIOS}mock-scenario-cards`;
const DIAGRAM = '/workspaces/ws_bio?material=mat_2';

for (const [name, url, text, read] of [
  [
    'note',
    '/workspaces/ws_bio?material=mat_note_1',
    'Prokaryotes vs eukaryotes',
    ['material', 'mat_note_1'],
  ],
  ['quiz', QUIZ, null, ['material', 'qz_bio_near']],
  [
    'flashcard set',
    CARDS,
    'Scenario flashcards',
    ['material', 'mock-scenario-cards'],
  ],
  ['diagram', DIAGRAM, null, ['material', 'mat_2']],
  ['text file', '/workspaces/ws_bio?file=f_3&mode=edit', null, ['file', 'f_3']],
] as const)
  test(`a ${name} editor refused by its room stays on the page, read-only`, async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    if (text)
      await expect(page.getByText(text).first()).toBeVisible({
        timeout: 60_000,
      });
    await expect.poll(() => readSettled(page, read)).toBeGreaterThan(0);
    const before = await readSettled(page, read);
    // Each joins its room on its own time after it paints.
    await expect
      .poll(() => refuseRooms(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expectStrip(page, read, before);
    if (text) await expect(page.getByText(text).first()).toBeVisible();
  });

// A note this device keeps a copy of reads without its body, so dropping to the
// reader's path would ask for a read the room's refusal says will fail.
test('a note editor with a device copy keeps what it holds when refused', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = 'A note for trying application errors.';
  await page.goto(`${SCENARIOS}mock-scenario-note`);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await clickTextEnd(editable(page).getByText(seed));
  await page.keyboard.type(' kept');
  const status = page.getByTestId('editor-save-state');
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await page.reload();
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveAttribute('data-save-state', 'saved');
  await clickTextEnd(editable(page).getByText(`${seed} kept`));
  await page.keyboard.type(' more');
  await expect(status).toHaveAttribute('data-save-state', 'saved');

  const read = ['material', 'mock-scenario-note'] as const;
  const before = await readSettled(page, read);
  await expect
    .poll(() => refuseRooms(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expectStrip(page, read, before);
  await expect(page.getByText(`${seed} kept more`)).toBeVisible();
  await expect(editable(page)).toHaveCount(0);
  await expect(status).toHaveCount(0);
});

// Epo 2026-11-20 ("the page should itself refetch and show the 404 error"):
// a room's refusal asks for the page's read, an access change (4403)
// included; refused too, the page says it is unavailable, with a toast saying
// they lost access, once, and the item leaves the Files panel, whose lists
// read again.
const NOTE_URL = '/workspaces/ws_bio?material=mat_note_1';
for (const [name, url, rows, id, close] of [
  ['note', NOTE_URL, 'materials', 'mat_note_1', 'refuseOpenRooms'],
  [
    'note closed for an access change (4403)',
    NOTE_URL,
    'materials',
    'mat_note_1',
    'closeOpenNotesForAccess',
  ],
  ['quiz', QUIZ, 'materials', 'qz_bio_near', 'refuseOpenRooms'],
  [
    'quiz closed for an access change (4403)',
    QUIZ,
    'materials',
    'qz_bio_near',
    'closeOpenItemsForAccess',
  ],
  [
    'text file',
    '/workspaces/ws_bio?file=f_3&mode=edit',
    'files',
    'f_3',
    'refuseOpenRooms',
  ],
] as const)
  test(`a ${name} refused by its room and by its read says it is unavailable`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    const listed = page.locator(
      `[data-workspace-file-tree] a[href*="${rows === 'files' ? 'file' : 'material'}=${id}"]`
    );
    await expect(listed.first()).toBeVisible({ timeout: 60_000 });
    // Its room joined: the toast is for an open editor's refusal alone.
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    const shown = page.getByText(m.error_not_found_title());
    await expect(async () => {
      await page.evaluate(
        async ({ close, rows, id }) => {
          const paths = ['/src/mocks/db.ts', '/src/mocks/collaboration.ts'];
          const [db, rooms] = await Promise.all(
            paths.map((path) => import(path))
          );
          const at = db[rows].findIndex((row: { id: string }) => row.id === id);
          if (at >= 0) db[rows].splice(at, 1);
          rooms[close]();
        },
        { close, id, rows }
      );
      await expect(shown).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(kickedToast(page)).toBeVisible();
    // No strip: only the toast says it.
    await expect(
      page.getByRole('status').filter({ hasText: m.editor_access_lost() })
    ).toHaveCount(0);
    // The lists read again drop it, and a note's header reads it again then:
    // once those had their chance, still one toast, never counted up.
    await expect(listed).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(2500);
    await expect(kickedToast(page)).toHaveCount(1);
    await expect(page.locator('.tst-count')).toHaveCount(0);
    if (shots && close === 'closeOpenNotesForAccess')
      await page.screenshot({ path: `${shots}/kicked-4403.png` });
    else if (shots && name === 'note')
      await page.screenshot({ path: `${shots}/kicked-unavailable.png` });
  });

// Review 2026-11-20 (1): the tree event hiding a note reaches the page before
// its room's drain, so its list drops it first and the header's read of it
// (the list no longer carries it) is refused while its room is still open.
// It worked here, so the page says it is unavailable with the toast all the
// same, and the room's refusal after it adds none.
test('a note its list drops before its room refuses says it is unavailable, with one toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(NOTE_URL);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  const listed = page.locator(
    '[data-workspace-file-tree] a[href*="material=mat_note_1"]'
  );
  await expect(listed.first()).toBeVisible({ timeout: 60_000 });
  // Refused from now, its read stale as five seconds make it, and its list
  // read again as the tree event does; nothing closes its room.
  await page.evaluate(async () => {
    const paths = ['/src/mocks/db.ts', '/src/api/queryClient.ts'];
    const [db, { queryClient }] = await Promise.all(
      paths.map((path) => import(path))
    );
    const at = db.materials.findIndex(
      (row: { id: string }) => row.id === 'mat_note_1'
    );
    db.materials.splice(at, 1);
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: ['material', 'mat_note_1'],
      refetchType: 'none',
    });
    await queryClient.invalidateQueries({
      queryKey: ['workspace', 'ws_bio', 'materials'],
    });
  });
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await expect(kickedToast(page)).toBeVisible();
  await expect(listed).toHaveCount(0, { timeout: 15_000 });
  // The room's refusal after it, should any room of it still be open.
  await refuseRooms(page);
  await page.waitForTimeout(2500);
  await expect(kickedToast(page)).toHaveCount(1);
  await expect(page.locator('.tst-count')).toHaveCount(0);
});

// Review 2026-11-20 (6): a file with no room (a PDF) hears of a kick from its
// list alone: once its workspace's files list no longer carries it, its page
// reads it again, refused, and says it is unavailable with the toast.
test('a PDF its list drops says it is unavailable, with one toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?file=f_1');
  await expect(page.getByTestId('content-header')).toBeVisible({
    timeout: 60_000,
  });
  const listed = page.locator('[data-workspace-file-tree] a[href*="file=f_1"]');
  await expect(listed.first()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => readSettled(page, ['file', 'f_1']))
    .toBeGreaterThan(0);
  // Refused from now, and its list read again as the tree event does.
  await page.evaluate(async () => {
    const paths = ['/src/mocks/db.ts', '/src/api/queryClient.ts'];
    const [db, { queryClient }] = await Promise.all(
      paths.map((path) => import(path))
    );
    const at = db.files.findIndex((row: { id: string }) => row.id === 'f_1');
    db.files.splice(at, 1);
    await queryClient.invalidateQueries({
      queryKey: ['workspace', 'ws_bio', 'files'],
    });
  });
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await expect(kickedToast(page)).toBeVisible();
  await expect(listed).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  await expect(kickedToast(page)).toHaveCount(1);
  await expect(page.locator('.tst-count')).toHaveCount(0);
});

// An item simply opened unavailable (its room never joined) says so as any
// refusal, with no toast: the person lost nothing they had open.
test('an item opened unavailable says so with no lost-access toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(NOTE_URL);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  const quiz = page.locator(
    '[data-workspace-file-tree] a[href*="material=qz_bio_near"]'
  );
  await expect(quiz.first()).toBeVisible({ timeout: 60_000 });
  // Gone from the API while the panel still lists it.
  await page.evaluate(async () => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const at = db.materials.findIndex(
      (row: { id: string }) => row.id === 'qz_bio_near'
    );
    db.materials.splice(at, 1);
  });
  await quiz.first().click();
  await expect(page.getByText(m.error_not_found_title())).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => readSettled(page, ['material', 'qz_bio_near']))
    .toBeGreaterThan(0);
  await expect(kickedToast(page)).toHaveCount(0);
});

for (const [name, url] of [
  ['quiz', QUIZ],
  ['flashcard set', CARDS],
  ['diagram', DIAGRAM],
] as const)
  test(`a ${name} editor lowered to a reader is told so`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => lowerRooms(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(page.getByText(m.editor_read_only_strip())).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  });

// A demotion as the server makes it: the role-change notice reads the
// workspace again (view-only now) at once, and the item's rooms close for the
// access change (4403) and rejoin on a read token later. The workspace's read
// drops the editor to view before its rooms hear, and the strip shows all the
// same (Epo 2026-11-05: a lowered editor reads on under it). `closed`: the
// rooms the access change closes (every kind's, a quiz's content and keys).
for (const [name, url, workspaceId, closed] of [
  ['quiz', QUIZ, 'ws_bio', 2],
  ['flashcard set', CARDS, 'ws_scenarios', 1],
  ['diagram', DIAGRAM, 'ws_bio', 1],
  ['note', NOTE_URL, 'ws_bio', 1],
] as const)
  test(`a ${name} editor demoted to viewer reads on under the read-only strip`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    expect(await demoteMember(page, workspaceId)).toBe(closed);
    await expect(page.getByText(m.editor_read_only_strip())).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
    await expect(page.getByText(m.error_not_found_title())).toHaveCount(0);
    await expect(kickedToast(page)).toHaveCount(0);
  });

// Main's order (UAT membership.spec, 65bdfc1e8): no notice reads the
// workspace, the content room closes for the access change (4403), and the
// quiz's keys, asking their first token as the demotion lands, are refused as
// read-only (403 `collaboration-read-only`). The quiz reads on under the
// read-only strip, not as refused; and once the quiz's read after it answered
// (view-only), the page's view keeps the strip.
test('a quiz opened as its editor is demoted reads under the read-only strip', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const keysAsked = page.waitForRequest(
    (request) =>
      request.url().includes('/qz_bio_near/collaboration-token') &&
      !!request.postData()?.includes('"keys"'),
    { timeout: 60_000 }
  );
  await page.goto(QUIZ);
  await keysAsked;
  // Its token held (MSW's latency), the keys join nothing yet; the content
  // room closes once it has joined.
  await expect
    .poll(() => demoteMember(page, 'ws_bio', false), { intervals: [50] })
    .toBe(1);
  const read = ['material', 'qz_bio_near'] as const;
  const before = await readSettled(page, read);
  expect(before).toBeGreaterThan(0);
  const strip = page.getByText(m.editor_read_only_strip());
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => readSettled(page, read), { timeout: 15_000 })
    .toBeGreaterThan(before);
  // The editor is gone, its Preview with it.
  await expect(
    page.getByRole('button', { exact: true, name: m.assignment_preview() })
  ).toHaveCount(0);
  await expect(strip).toBeVisible();
  await expect(page.locator('[data-question-id]').first()).toBeVisible();
  await expect(page.getByText(m.editor_access_lost())).toHaveCount(0);
  await expect(page.getByText(m.error_not_found_title())).toHaveCount(0);
  await expect(kickedToast(page)).toHaveCount(0);
});

// A read of the quiz after the demotion (another tab's change, a refetch)
// finds it view-only and the page draws it for viewing: the strip stays, as
// the quiz told the page it reads.
test('a demoted quiz editor keeps the read-only strip when its quiz is read again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(QUIZ);
  await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 60_000 }
  );
  expect(await demoteMember(page, 'ws_bio', false)).toBe(2);
  const strip = page.getByText(m.editor_read_only_strip());
  await expect(strip).toBeVisible({ timeout: 15_000 });
  const read = ['material', 'qz_bio_near'] as const;
  await expect.poll(() => readSettled(page, read)).toBeGreaterThan(0);
  const before = await readSettled(page, read);
  await page.evaluate(async (queryKey) => {
    const path = '/src/api/queryClient.ts';
    const { queryClient } = await import(path);
    await queryClient.invalidateQueries({ queryKey });
  }, read);
  await expect
    .poll(() => readSettled(page, read), { timeout: 15_000 })
    .toBeGreaterThan(before);
  // The editor is gone, its Preview with it.
  await expect(
    page.getByRole('button', { exact: true, name: m.assignment_preview() })
  ).toHaveCount(0);
  await expect(strip).toBeVisible();
});

/** The mock's role change (`raiseMockMember`): editor again, with its notice. */
const raiseMember = (page: Page, workspaceId: string) =>
  page.evaluate(async (id) => {
    const path = '/src/mocks/collaboration.ts';
    const { raiseMockMember } = await import(path);
    raiseMockMember(id);
  }, workspaceId);

/** The payer of `id` at its storage limit, or free again: its read says so from
 * now on, a full payer's rooms turn read-only (`room-read-only`), and the page
 * reads it again, as the storage strip's next read would. */
const payerFull = (page: Page, id: string, full: boolean, announce = true) =>
  page.evaluate(
    async ([materialId, isFull, rooms]) => {
      const paths = [
        '/src/mocks/db.ts',
        '/src/mocks/collaboration.ts',
        '/src/api/queryClient.ts',
      ];
      const [db, collaboration, { queryClient }] = await Promise.all(
        paths.map((path) => import(path))
      );
      const row = db.materials.find(
        (item: { id: string }) => item.id === materialId
      );
      row.capabilities = { ...row.capabilities, canEditContent: !isFull };
      row.storageFull = isFull ? 'payer' : undefined;
      if (isFull && rooms) collaboration.announceReadOnly();
      await queryClient.invalidateQueries({
        queryKey: ['material', materialId],
      });
    },
    [id, full, announce] as const
  );

/** Goes to `url` in the app, as a link does: the page's caches stay. */
const visit = (page: Page, url: string) =>
  page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);

const SETS = [
  ['quiz', QUIZ, 'ws_bio', 'qz_bio_near', m.quiz_add_question()],
  [
    'flashcard set',
    CARDS,
    'ws_scenarios',
    'mock-scenario-cards',
    m.flashcards_add_card(),
  ],
] as const;

// A full payer's storage takes no right: the quiz or set reads under the
// storage strip, and edits again once a read says the payer has room.
for (const [name, url, , id, add] of SETS)
  test(`a ${name} editor whose payer's storage fills edits again once it has room`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    const adds = page.getByRole('button', { exact: true, name: add });
    await payerFull(page, id, true);
    const storage = page.getByText(m.storage_payer_full_strip());
    await expect(storage).toBeVisible({ timeout: 15_000 });
    await expect(adds).toHaveCount(0);
    await payerFull(page, id, false);
    await expect(adds.first()).toBeEnabled({ timeout: 15_000 });
    await expect(storage).toHaveCount(0);
    await expect(page.getByText(m.editor_read_only_strip())).toHaveCount(0);
  });

// A full payer's storage takes no right, read before the rooms say anything:
// a diagram, which a lowering keeps read-only until a reload, reads under the
// storage strip alone and edits again once the payer has room.
test("a diagram editor whose payer's storage fills, its room silent, edits again once it has room", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio?material=mat_2');
  const saveState = page.getByTestId('editor-save-state');
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 60_000,
  });
  await payerFull(page, 'mat_2', true, false);
  const storage = page.getByText(m.storage_payer_full_strip());
  await expect(storage).toBeVisible({ timeout: 15_000 });
  await expect(saveState).toHaveCount(0);
  await payerFull(page, 'mat_2', false);
  await expect(saveState).toHaveAttribute('data-save-state', 'saved', {
    timeout: 15_000,
  });
  await expect(storage).toHaveCount(0);
  await expect(page.getByText(m.editor_read_only_strip())).toHaveCount(0);
});

// Q642 C: a quiz or set editor demoted, then raised again, edits again once
// the raise's notice reads the workspace and the item (nothing closes for it).
for (const [name, url, workspaceId, , add] of SETS)
  test(`a ${name} editor demoted and raised again edits it again`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    await demoteMember(page, workspaceId);
    const strip = page.getByText(m.editor_read_only_strip());
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await raiseMember(page, workspaceId);
    await expect(
      page.getByRole('button', { exact: true, name: add }).first()
    ).toBeEnabled({ timeout: 15_000 });
    await expect(strip).toHaveCount(0);
  });

// D1: someone demoted while away opens the item with no view-only cue, though
// its device copy (kept under MSW for the scenario items alone) paints an
// editor's page and the workspace's kept read still says they may edit.
for (const [name, url, workspaceId, read] of [
  [
    'quiz',
    `${SCENARIOS}mock-scenario-quiz`,
    'ws_scenarios',
    ['material', 'mock-scenario-quiz'],
  ],
  ['flashcard set', CARDS, 'ws_scenarios', ['material', 'mock-scenario-cards']],
] as const)
  test(`a ${name} editor demoted while away opens it with no strip`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 60_000 }
    );
    // Away on the workspace's page, demoted with no notice. As at a reload, the
    // item's read goes and the workspace's kept read (persisted) still says
    // they may edit.
    await visit(page, `/workspaces/${workspaceId}`);
    await expect(page.getByTestId('editor-save-state')).toHaveCount(0);
    await page.evaluate(
      async ([id, queryKey, text]) => {
        const paths = [
          '/src/api/queryClient.ts',
          '/src/mocks/collaboration.ts',
        ];
        const [{ queryClient }, { demoteMockMember }] = await Promise.all(
          paths.map((path) => import(path))
        );
        const workspace = ['workspace', id];
        const kept = queryClient.getQueryData(workspace);
        demoteMockMember(id, false);
        queryClient.setQueryData(workspace, kept);
        queryClient.removeQueries({ exact: true, queryKey });
        // Whether the strip ever shows from here on.
        const seen = window as unknown as { stripSeen: boolean };
        seen.stripSeen = false;
        new MutationObserver(() => {
          if (document.body.innerText.includes(text)) seen.stripSeen = true;
        }).observe(document.body, {
          characterData: true,
          childList: true,
          subtree: true,
        });
      },
      [workspaceId, read, m.editor_read_only_strip()] as const
    );
    await visit(page, url);
    await expect
      .poll(() => readSettled(page, read), { timeout: 15_000 })
      .toBeGreaterThan(0);
    // Its view, the editor gone with the room it may have joined meanwhile.
    await expect(page.getByTestId('content-header')).toBeVisible();
    await expect(page.getByTestId('editor-save-state')).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(
      await page.evaluate(
        () => (window as unknown as { stripSeen: boolean }).stripSeen
      )
    ).toBe(false);
  });
