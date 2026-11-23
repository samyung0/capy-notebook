import { expect, type Page, test } from '@playwright/test';

/**
 * Other people on a canvas (Epo 2026-11-18), against the mock room
 * (src/mocks/collaboration.ts, the board room): a second person's pointer,
 * selection and text caret show for the first, follow the board, and go when
 * they leave; the first's own reach the second; a workspace viewer's tab sets
 * no presence and is told of none; the canvas's maker narrowed to a read
 * channel still sets theirs.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Peer = ReturnType<Collaboration['mockBoardPeer']>;
type Presence = { b?: string[]; f?: string; p?: number[] | null; s?: string };
type Board = {
  presence: {
    view(): { left: number; top: number; zoom: number };
  };
};
type Shown = { __board?: Board; peer?: Peer };

/** A workspace's first canvas, as the mocks name it. */
const CANVAS = 'cv_ws_bio_1';
const BEN = { avatar: null, name: 'Ben', person: 5 };

async function boardShown(page: Page) {
  await page.waitForFunction(() => (window as Shown).__board);
  // The dev scenario panel sits over the toolbar's right end.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
}

/** Ben joins the canvas's room, headless, as `window.peer`. */
const joinBen = (page: Page, id: string) =>
  page.evaluate(
    async ([canvasId, identity]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockBoardPeer } = (await import(modulePath)) as Collaboration;
      Object.assign(window, { peer: mockBoardPeer(canvasId, identity) });
    },
    [id, BEN] as const
  );

/** What this person's own tab says of itself on a canvas, relayed or not:
 * null while it has said nothing. */
const ownPresence = (page: Page, id: string) =>
  page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockBoardOwnPresence } = (await import(
      modulePath
    )) as Collaboration;
    return mockBoardOwnPresence(canvasId);
  }, id);

/** What the other tabs say, as Ben hears it. */
const heardByBen = (page: Page) =>
  page.evaluate(() => {
    const awareness = (window as Shown).peer?.awareness;
    if (!awareness) throw new Error('no peer');
    return [...awareness.getStates()]
      .filter(([client]) => client !== awareness.clientID)
      .map(([, state]) => state as Presence);
  });

/** Where the board point (`x`, `y`) is on the page now. */
const onPage = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([boardX, boardY]) => {
      const view = (window as Shown).__board?.presence.view();
      const host = document.querySelector('.capy-board');
      if (!(view && host)) throw new Error('no board');
      const box = host.getBoundingClientRect();
      return [
        box.x + view.left + boardX * view.zoom,
        box.y + view.top + boardY * view.zoom,
      ];
    },
    [x, y] as const
  );

test("another person's pointer, selection and caret show, follow the board, and go when they leave", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  // A note to type in.
  await page.mouse.dblclick(board.x + board.width / 2, board.y + 220);
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  await page.keyboard.type('Cells divide');
  const note = page.locator('affine-edgeless-note');
  await expect(note).toContainText('Cells divide');
  await joinBen(page, CANVAS);

  // This person's own caret and the note it is in reach Ben as soon as the
  // caret is there, and again when it moves with nothing typed.
  await expect
    .poll(async () => (await heardByBen(page))[0])
    .toMatchObject({ b: [expect.any(String)], s: expect.any(String) });
  const [typed] = await heardByBen(page);
  await page.keyboard.press('Home');
  await expect
    .poll(async () => (await heardByBen(page))[0]?.s)
    .not.toBe(typed.s);
  await page.mouse.move(board.x + 300, board.y + 300);
  await expect
    .poll(async () => (await heardByBen(page))[0]?.p)
    .toEqual([expect.any(Number), expect.any(Number)]);
  expect(await ownPresence(page, CANVAS)).toMatchObject({
    p: [expect.any(Number), expect.any(Number)],
  });

  // Ben points at the board, with the note selected and his caret after
  // "Cells".
  await page.evaluate(
    ([id]) => {
      const peer = (window as Shown).peer;
      if (!peer) throw new Error('no peer');
      peer.awareness.setLocalState({
        b: [id],
        p: [40, 60],
        ...peer.caret('Cells divide', 5),
      });
    },
    [typed.b?.[0] ?? '']
  );
  const pointer = page.locator('[data-remote-pointer="Ben"]');
  const outline = page.locator('[data-remote-run="Ben"]');
  const caret = page.locator('[data-remote-caret="Ben"]');
  for (const mark of [pointer, outline, caret])
    await expect(mark).toHaveCount(1);
  await expect(pointer).toContainText('Ben');
  await expect(outline).toContainText('Ben');
  /** How far the pointer's tip is from its board point, in pixels. */
  const tip = async () => {
    const box = await pointer.boundingBox();
    if (!box) throw new Error('no pointer');
    const [x, y] = await onPage(page, 40, 60);
    return Math.max(Math.abs(box.x - x), Math.abs(box.y - y));
  };
  await expect.poll(tip).toBeLessThan(1);
  // His caret stands in the note's text, and the outline is around the note.
  const [text, bar, around] = await Promise.all(
    [note, caret, outline].map((mark) => mark.boundingBox())
  );
  if (!(text && bar && around)) throw new Error('a mark is gone');
  expect(bar.x).toBeGreaterThan(text.x);
  expect(bar.x).toBeLessThan(text.x + text.width);
  expect(bar.y).toBeGreaterThanOrEqual(text.y - 1);
  expect(bar.y + bar.height).toBeLessThanOrEqual(text.y + text.height + 1);
  expect(around.x).toBeLessThan(bar.x);
  expect(around.x + around.width).toBeGreaterThan(text.x + text.width - 8);
  expect(around.y).toBeLessThan(bar.y);
  expect(around.y + around.height).toBeGreaterThan(bar.y + bar.height);

  // A range he selects is tinted.
  await page.evaluate(() => {
    const peer = (window as Shown).peer;
    if (!peer) throw new Error('no peer');
    peer.awareness.setLocalState({
      ...peer.awareness.getLocalState(),
      ...peer.caret('Cells divide', 0, 5),
    });
  });
  await expect(page.locator('[data-remote-cursor="Ben"]')).toHaveCount(1);

  // The board pans and zooms: the pointer stays on its board point.
  const view = () =>
    page.evaluate(() => (window as Shown).__board?.presence.view());
  const opened = await view();
  await page.keyboard.press('Escape');
  await page.mouse.move(board.x + 200, board.y + board.height - 200);
  await page.mouse.wheel(90, 60);
  await expect.poll(async () => (await view())?.left).not.toBe(opened?.left);
  await expect.poll(tip).toBeLessThan(1);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('ControlOrMeta');
  await expect.poll(async () => (await view())?.zoom).not.toBe(opened?.zoom);
  await expect.poll(tip).toBeLessThan(1);

  await page.evaluate(() => (window as Shown).peer?.leave());
  for (const mark of [pointer, outline, caret])
    await expect(mark).toHaveCount(0);
});

test('a workspace viewer sends no presence and is told of none', async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
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
  // The picker reads the list as it opens (a reload would start the mocks
  // afresh).
  await page
    .locator('[data-workspace-canvas]')
    .getByRole('button', { exact: true, name: 'Biology 101' })
    .click();
  await page.getByRole('button', { name: 'Lab diagrams' }).click();
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await expect(page.locator('edgeless-toolbar-widget')).toHaveCount(0);
  // Once the viewer's board has opened its room.
  await expect
    .poll(() =>
      joinBen(page, theirs).then(
        () => true,
        () => false
      )
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as Shown).peer?.awareness.setLocalState({ p: [40, 60] })
  );
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  await page.mouse.move(board.x + 200, board.y + 200);
  await page.mouse.move(board.x + 260, board.y + 240, { steps: 4 });
  // Past the 50 ms a pointer waits at most.
  await page.waitForTimeout(300);
  // The tab itself said nothing: the mock room relays nothing a read channel
  // says, so Ben would hear nothing either way.
  expect(await ownPresence(page, theirs)).toBeNull();
  expect(await heardByBen(page)).toEqual([]);
  await expect(page.locator('[data-remote-pointer]')).toHaveCount(0);
});

test("the canvas's maker still sets their presence once their channel is narrowed to read", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  const pointer = async () => (await ownPresence(page, CANVAS))?.p;
  await page.mouse.move(board.x + 300, board.y + 300);
  await expect.poll(pointer).toEqual([expect.any(Number), expect.any(Number)]);
  const before = await pointer();

  // Their account is frozen: the room closes the channel, the next token
  // reads, and the board takes no edits.
  await page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockNarrowBoard } = (await import(modulePath)) as Collaboration;
    mockNarrowBoard(canvasId);
  }, CANVAS);
  await expect
    .poll(() =>
      page.evaluate(async (canvasId) => {
        const modulePath = '/src/mocks/collaboration.ts';
        const { mockBoardChannel } = (await import(
          modulePath
        )) as Collaboration;
        return mockBoardChannel(canvasId);
      }, CANVAS)
    )
    .toBe('read');
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
  // The tab still says where its pointer is (the mock room relays nothing a
  // read channel says, so this is read off the tab itself).
  await page.mouse.move(board.x + 440, board.y + 380, { steps: 4 });
  await expect.poll(pointer).not.toEqual(before);
  expect(await pointer()).toEqual([expect.any(Number), expect.any(Number)]);
});

/** A board note's size reaches the room once typing pauses, not after every
 * key (vendor/blocksuite local change 75): the other person sees the size the
 * typist's tab shows, and the typed text is held in a few runs, where a size
 * written after every key left one per character. */
test("a note's size reaches another person once typing pauses, its text in a few runs", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
  await joinBen(page, CANVAS);
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  // An inline note, as wide as its text.
  await page.mouse.dblclick(board.x + board.width / 2, board.y + 220);
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  const sentence = 'Cells divide and grow';
  // A typist's pace: each key measured in its own frame.
  await page.keyboard.type(sentence, { delay: 60 });
  await expect(page.locator('affine-edgeless-note')).toContainText(sentence);

  /** The note's size as this tab shows it and as Ben holds it, and how many
   * runs hold its text for Ben. */
  const sizes = () =>
    page.evaluate(() => {
      type Holder = { get(key: string): unknown };
      const { model } = document.querySelector(
        'affine-edgeless-note'
      ) as unknown as {
        model: { children: { id: string }[]; id: string; xywh: string };
      };
      const peer = (window as Shown).peer;
      if (!peer) throw new Error('no peer');
      const blocks = peer.document.getMap<Holder>('blocks');
      const text = blocks.get(model.children[0].id)?.get('prop:text');
      let runs = 0;
      for (const structs of peer.document.store.clients.values())
        for (const struct of structs)
          if ('parent' in struct && struct.parent === text && !struct.deleted)
            runs++;
      return {
        held: blocks.get(model.id)?.get('prop:xywh'),
        runs,
        shown: model.xywh,
      };
    });
  await expect
    .poll(async () => {
      const { held, shown } = await sizes();
      return held === shown;
    })
    .toBe(true);
  // The sentence's 21 characters, where every key's size took a clock.
  expect((await sizes()).runs).toBeLessThanOrEqual(3);
});

/** A note's size waiting on a pause in typing (vendor/blocksuite local change
 * 75) is stored at once when its editing ends or the board is saved or
 * snapshotted, and dropped, nothing written, when the board locks; unlocked,
 * the board measures the note again and stores it. */
test("a note's waiting size is stored when editing ends or the board is saved, and dropped when it locks until it unlocks", async ({
  page,
}) => {
  test.slow();
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
  const board = await page.locator('.capy-board').boundingBox();
  if (!board) throw new Error('no board');
  type Steps = {
    save(): unknown;
    setLocked(locked: boolean): void;
    snapshot(): unknown;
  };

  /** Types `text` into a new inline note `y` down the board. */
  const typeNote = async (y: number, text: string) => {
    await page.mouse.dblclick(board.x + board.width / 2, board.y + y);
    await page.waitForFunction(
      () => document.activeElement?.closest('affine-edgeless-note') != null
    );
    await page.keyboard.type(text);
  };

  /** The size of the note holding `text`, as stored and as shown, around
   * `step` taken straight after typing (after the frame that measures). */
  const around = (
    text: string,
    step: 'none' | 'end' | 'save' | 'snapshot' | 'lock'
  ) =>
    page.evaluate(
      async ([held, taken]) => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const note = [
          ...document.querySelectorAll('affine-edgeless-note'),
        ].find((element) => element.textContent?.includes(held)) as unknown as {
          model: { xywh: string; yBlock: { get(key: string): unknown } };
        };
        const stored = () => note.model.yBlock.get('prop:xywh');
        const before = { shown: note.model.xywh, stored: stored() };
        const steps = (window as unknown as { __board: Steps }).__board;
        if (taken === 'end') {
          // What Escape or a click elsewhere leads to.
          const root = document.querySelector(
            'affine-edgeless-root'
          ) as unknown as { gfx: { selection: { clear(): void } } };
          root.gfx.selection.clear();
        }
        if (taken === 'save') steps.save();
        if (taken === 'snapshot') steps.snapshot();
        if (taken === 'lock') steps.setLocked(true);
        return { after: { shown: note.model.xywh, stored: stored() }, before };
      },
      [text, step] as const
    );

  // Editing ends, or the board is saved or snapshotted while it is edited:
  // stored at once.
  for (const [y, text, step] of [
    [150, 'Cells divide', 'end'],
    [260, 'and grow', 'save'],
    [370, 'in mitosis', 'snapshot'],
  ] as const) {
    await typeNote(y, text);
    const { after, before } = await around(text, step);
    expect(before.stored, step).not.toBe(before.shown);
    expect(after.stored, step).toBe(before.shown);
  }

  // The board locks while it is edited: the size is dropped, never written,
  // and still shown in this tab alone.
  await typeNote(480, 'Chromosomes pair');
  const locked = await around('Chromosomes pair', 'lock');
  expect(locked.before.stored).not.toBe(locked.before.shown);
  expect(locked.after.stored).toBe(locked.before.stored);
  expect(locked.after.shown).toBe(locked.before.shown);
  await page.waitForTimeout(1000);
  const later = await around('Chromosomes pair', 'none');
  expect(later.before.stored).toBe(locked.before.stored);
  // Unlocked: measured again, the size goes in as this tab's, after its pause.
  await page.evaluate(() =>
    (window as unknown as { __board: Steps }).__board.setLocked(false)
  );
  const height = (xywh: unknown) => (JSON.parse(String(xywh)) as number[])[3];
  await expect
    .poll(
      async () =>
        Math.abs(
          height((await around('Chromosomes pair', 'none')).before.stored) -
            height(locked.before.shown)
        ),
      { timeout: 3000 }
    )
    .toBeLessThan(1);
});
