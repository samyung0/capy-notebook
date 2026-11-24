import { expect, type Page, test } from '@playwright/test';

/**
 * A board note whose stored height is less than its text (fonts that wrap it
 * differently, a card added by code and saved before it was measured). Every
 * tab shows the size its own text measures at once, as a value of its own it
 * never writes (vendor/blocksuite local change 75), so a double click or a
 * click on the note's last line meets the note, not empty board: right after
 * an editor's board opens, before it would write the size (3 s), and in a
 * tab that never writes it.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Canvases = typeof import('../../src/mocks/canvas');
type Peer = ReturnType<Collaboration['mockBoardPeer']>;
type Box = { h: number; w: number; x: number; y: number };
type YMap = {
  clone(): YMap;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};
type Root = HTMLElement & {
  gfx: {
    getElementById(id: string): unknown;
    selection: { selectedBound: Box };
    viewport: {
      left: number;
      top: number;
      toViewCoord(x: number, y: number): [number, number];
    };
  };
  std: {
    store: {
      addBlock(flavour: string, props: object, parent: string): string;
      getBlock(id: string): {
        model: {
          props: { text: { insert(text: string, at: number): void } };
          yBlock: YMap;
        };
      };
      root: { id: string };
    };
  };
};
type Shown = {
  __board?: {
    fit(padding: [number, number, number, number]): void;
    kept?: boolean;
    presence: { selected(): string[] };
    save(): { doc: string };
    snapshot(): string;
    stats(): { canvas: string[] };
  };
  __reopen?: (saved: string) => void;
  peer?: Peer;
  template?: { note: [string, YMap]; paragraphs: [string, YMap][] };
};

/** The note's height as stored and its text's three lines, each long enough
 * to wrap on a card 340 wide. */
const STORED = 60;
const LINES = [1, 2, 3].map(
  (line) =>
    `Line ${line}: the force on the block is its mass times its acceleration.`
);

/** Adds a card 340 wide and 60 high at (`x`, `y`) holding `LINES`, in the
 * same task as the caller's next step, before its text is measured. */
const addCard = `(x, y) => {
  const { store } = document.querySelector('affine-edgeless-root').std;
  const note = store.addBlock('affine:note',
    { xywh: '[' + x + ',' + y + ',340,${STORED}]' }, store.root.id);
  const paragraphs = ${JSON.stringify(LINES)}.map((line) => {
    const id = store.addBlock('affine:paragraph', {}, note);
    store.getBlock(id).model.props.text.insert(line, 0);
    return id;
  });
  return { note, paragraphs };
}`;

/** The note's stored height, its text's height, where the middle of its last
 * line is on the page, and whether the note is what is there (no toolbar over
 * it). */
const measure = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector('affine-edgeless-note') as
      | (HTMLElement & { model: { yBlock: YMap } })
      | null;
    const line = [...(element?.querySelectorAll('affine-paragraph') ?? [])].at(
      -1
    );
    const mask = element?.querySelector<HTMLElement>('.affine-note-mask');
    if (!(element && line && mask)) return null;
    const { gfx } = document.querySelector('affine-edgeless-root') as Root;
    const [x, y, , h] = JSON.parse(
      String(element.model.yBlock.get('prop:xywh'))
    ) as number[];
    const [, bottom] = gfx.viewport.toViewCoord(x, y + h);
    const box = line.getBoundingClientRect();
    const at: [number, number] = [box.x + 20, box.y + box.height / 2];
    return {
      // The stored bottom on the page, as the board's hit test reads it.
      bottom: bottom + gfx.viewport.top,
      line: at,
      onNote: element.contains(document.elementFromPoint(...at)),
      stored: h,
      text: mask.offsetHeight,
    };
  });

test("an editor's board takes a double click on a note's last line, below its stored height, right after it opens", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/drawing');
  await page.waitForFunction(() =>
    (window as Shown).__board?.stats().canvas.includes('plane')
  );
  // Saved in the task that adds it, so the board keeps 60.
  const saved = await page.evaluate(`(() => {
    (${addCard})(0, 600);
    return window.__board.save().doc;
  })()`);
  await page.evaluate(
    (doc) => (window as Shown).__reopen?.(String(doc)),
    saved
  );
  await page.waitForFunction(
    (line) =>
      [...document.querySelectorAll('affine-edgeless-note')].some((note) =>
        note.textContent?.includes(line)
      ),
    LINES[2]
  );
  // [top, right, bottom, left]: room under the stored 60 for the text, clear
  // of the toolbar.
  await page.evaluate(() => (window as Shown).__board?.fit([40, 40, 300, 40]));
  await expect.poll(() => measure(page)).not.toBeNull();
  const shown = await measure(page);
  if (!shown) throw new Error('no note');
  // Within the 3 s an editor's tab waits before it writes the size: the last
  // line is past the stored bottom.
  expect(shown.stored).toBe(STORED);
  expect(shown.text).toBeGreaterThan(STORED + 40);
  expect(shown.line[1]).toBeGreaterThan(shown.bottom + 10);
  expect(shown.onNote).toBe(true);
  await page.mouse.dblclick(...shown.line);
  // A double click on empty board would have started a text label.
  await expect
    .poll(() =>
      page.evaluate(() => ({
        canvas: (window as Shown).__board?.stats().canvas,
        inNote: document.activeElement?.closest('affine-edgeless-note') != null,
      }))
    )
    .toEqual({ canvas: ['plane'], inNote: true });
  expect(errors).toEqual([]);
});

const CANVAS = 'Biology 101';
const BEN = { avatar: null, name: 'Ben', person: 5 };

/** Opens `title` from the picker of the canvas showing as `from`. */
async function switchTo(page: Page, from: string, title: string) {
  await page
    .locator('[data-workspace-canvas]')
    .getByRole('button', { exact: true, name: from })
    .click();
  await page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: title })
    .click();
}

/** On the workspace canvas, a canvas this person holds by `role`, made by
 * Ben, who adds the card (`addCard`, 60 high) once both are in. Returns the
 * card's id. */
async function bensCard(page: Page, role: 'editor' | 'viewer') {
  await page.goto('/workspaces/ws_bio?view=canvas');
  await page.waitForFunction(() => (window as Shown).__board);
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  // The note as an editor's board stores it, copied for Ben to add.
  await page.evaluate(`(() => {
    const { note, paragraphs } = (${addCard})(0, 0);
    const { store } = document.querySelector('affine-edgeless-root').std;
    const copy = (id) => [id, store.getBlock(id).model.yBlock.clone()];
    window.template = { note: copy(note), paragraphs: paragraphs.map(copy) };
  })()`);
  const canvasId = await page.evaluate(async (role) => {
    const modulePath = '/src/mocks/canvas.ts';
    const { mockMemberCanvas } = (await import(modulePath)) as Canvases;
    return mockMemberCanvas({
      creatorName: 'Ben',
      role,
      title: 'Lab diagrams',
      workspaceId: 'ws_bio',
    });
  }, role);
  await switchTo(page, CANVAS, 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${canvasId}`));
  await expect
    .poll(() =>
      page.evaluate(
        async ([canvasId, identity]) => {
          const modulePath = '/src/mocks/collaboration.ts';
          const { mockBoardPeer } = (await import(modulePath)) as Collaboration;
          try {
            Object.assign(window, { peer: mockBoardPeer(canvasId, identity) });
            return true;
          } catch {
            return false;
          }
        },
        [canvasId, BEN] as const
      )
    )
    .toBe(true);
  await page.evaluate(() =>
    Object.assign((window as Shown).__board ?? {}, { kept: true })
  );
  // Ben adds it, 60 high, its three lines wrapping taller.
  const id = await page.evaluate(() => {
    const { peer, template } = window as Shown;
    if (!(peer && template)) throw new Error('no peer');
    const blocks = peer.document.getMap<YMap>('blocks');
    const root = [...blocks.values()].find(
      (block) => block.get('sys:flavour') === 'affine:page'
    );
    const children = root?.get('sys:children') as
      | { push(ids: string[]): void }
      | undefined;
    if (!children) throw new Error('no page block');
    peer.document.transact(() => {
      for (const [id, paragraph] of template.paragraphs)
        blocks.set(id, paragraph);
      blocks.set(...template.note);
      children.push([template.note[0]]);
    });
    return template.note[0];
  });
  await page.waitForFunction(
    (line) =>
      [...document.querySelectorAll('affine-edgeless-note')].some((note) =>
        note.textContent?.includes(line)
      ),
    LINES[2]
  );
  return id;
}

test("a viewer's board selects a note by its last line, below its stored height, its frame round the text, and writes nothing", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await bensCard(page, 'viewer');
  await page.evaluate(() => (window as Shown).__board?.fit([80, 80, 80, 80]));
  const before = await page.evaluate(() =>
    (window as Shown).__board?.snapshot()
  );
  // Past the 3 s an editor waits before writing: a viewer never writes it.
  await page.waitForTimeout(3500);
  await expect.poll(() => measure(page)).not.toBeNull();
  const shown = await measure(page);
  if (!shown) throw new Error('no note');
  expect(shown.stored).toBe(STORED);
  expect(shown.line[1]).toBeGreaterThan(shown.bottom + 10);
  expect(shown.onNote).toBe(true);
  await page.mouse.click(...shown.line);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Shown).__board?.presence.selected())
    )
    .toEqual([id]);
  // The selection's frame is the text's height, not the stored 60.
  const frame = await page.evaluate(() => {
    const { gfx } = document.querySelector('affine-edgeless-root') as Root;
    return gfx.selection.selectedBound.h;
  });
  expect(Math.abs(frame - shown.text)).toBeLessThan(1);
  // A write on a read channel would close it and open the room afresh.
  expect(
    await page.evaluate(() => (window as Shown).__board?.kept === true)
  ).toBe(true);
  expect(await page.evaluate(() => (window as Shown).__board?.snapshot())).toBe(
    before
  );
  expect(errors).toEqual([]);
});

test("an editor's drag of a note showing the size its text measures starts from that size and stores it, and its Undo moves the note back alone", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await bensCard(page, 'editor');
  await page.evaluate(() => (window as Shown).__board?.fit([80, 80, 80, 80]));
  /** The note's `xywh` in Ben's tab, as the room relays it. */
  const onBen = () =>
    page.evaluate((id) => {
      const block = (window as Shown).peer?.document
        .getMap<YMap>('blocks')
        .get(id);
      return JSON.parse(String(block?.get('prop:xywh'))) as number[];
    }, id);
  // This tab writes what its text measures after 3 s. Ben's tab, its fonts
  // wrapping the text in 60, writes 60 back: each then shows its own size
  // and writes no more.
  await expect
    .poll(async () => (await onBen())[3], { timeout: 10_000 })
    .toBeGreaterThan(STORED + 40);
  await page.evaluate(
    ([id, xywh]) => {
      const { peer } = window as Shown;
      const block = peer?.document.getMap<YMap>('blocks').get(id);
      if (!(peer && block)) throw new Error('no note');
      peer.document.transact(() => block.set('prop:xywh', xywh));
    },
    [id, `[0,0,340,${STORED}]`] as const
  );
  await expect.poll(async () => (await measure(page))?.stored).toBe(STORED);
  const shown = await measure(page);
  if (!shown) throw new Error('no note');
  /** The note's frame in this tab: the height it shows. */
  const frame = () =>
    page.evaluate(() => {
      const note = document.querySelector('affine-edgeless-note') as
        | (HTMLElement & { model: { xywh: string } })
        | null;
      return (JSON.parse(note?.model.xywh ?? '[]') as number[])[3];
    });
  expect(Math.abs((await frame()) - shown.text)).toBeLessThan(1);
  // Pressed on its first line and moved past the drag's threshold: the drag
  // has started, and the frame is still the text's.
  const first = await page.evaluate(() => {
    const line = document.querySelector(
      'affine-edgeless-note affine-paragraph'
    );
    const box = line?.getBoundingClientRect();
    if (!box) throw new Error('no line');
    return [box.x + 20, box.y + box.height / 2] as const;
  });
  await page.mouse.move(...first);
  await page.mouse.down();
  await page.mouse.move(first[0] + 40, first[1] + 40);
  expect(Math.abs((await frame()) - shown.text)).toBeLessThan(1);
  await page.mouse.move(first[0] + 80, first[1] + 80, { steps: 4 });
  await page.mouse.up();
  // Stored at the height shown, and moved.
  await expect
    .poll(async () => (await onBen())[3])
    .toBeGreaterThan(STORED + 40);
  expect((await onBen())[0]).toBeGreaterThan(0);
  // The step holds the move alone: its Undo puts the note back where it was,
  // at its text's height.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await onBen()).slice(0, 3))
    .toEqual([0, 0, 340]);
  expect(Math.abs((await onBen())[3] - shown.text)).toBeLessThan(1);
  expect(Math.abs((await frame()) - shown.text)).toBeLessThan(1);
  expect(errors).toEqual([]);
});

/** Ben joins the card `id` (stored 60 high at the origin) to a square below
 * it with a labelled connector, its label placed where his tab, showing 60,
 * puts it: the middle of the path from (170, 60) to (170, 400). */
const bensConnector = (page: Page, id: string) =>
  page.evaluate((id) => {
    const { peer } = window as Shown;
    if (!peer) throw new Error('no peer');
    peer.document.transact(() => {
      peer.add('to', {
        fillColor: '#ffffff',
        filled: false,
        index: 'a0',
        radius: 0,
        rotate: 0,
        roughness: 1.4,
        seed: 1,
        shapeStyle: 'General',
        shapeType: 'rect',
        strokeColor: '#000000',
        strokeStyle: 'solid',
        strokeWidth: 2,
        type: 'shape',
        xywh: '[120,400,100,100]',
      });
      peer.add('join', {
        index: 'a1',
        labelDisplay: true,
        labelOffset: { distance: 0.5 },
        labelXYWH: [140, 218, 60, 24],
        mode: 0,
        rough: false,
        roughness: 1.4,
        seed: 2,
        source: { id, position: [0.5, 1] },
        stroke: '#000000',
        strokeStyle: 'solid',
        strokeWidth: 2,
        target: { id: 'to', position: [0.5, 0] },
        text: 'feeds',
        type: 'connector',
      });
    });
  }, id);

/** The connector as this tab shows it: where its path starts, whether its
 * label holds the point its offset puts on the path (drawn and hit there), the
 * label as stored, and a point on the page inside the label, 20 right of the
 * line, where only the label is hit. */
const labelled = (page: Page) =>
  page.evaluate(() => {
    const { gfx } = document.querySelector('affine-edgeless-root') as Root;
    const connector = gfx.getElementById('join') as {
      absolutePath: [number, number][];
      labelIncludesPoint(point: [number, number]): boolean;
      labelOffset: { distance: number };
      labelXYWH?: number[];
    } | null;
    const path = connector?.absolutePath ?? [];
    if (!connector || path.length < 2) return null;
    // A straight connector: its two ends.
    const [start, end] = path;
    const { distance } = connector.labelOffset;
    const point: [number, number] = [
      start[0] + (end[0] - start[0]) * distance,
      start[1] + (end[1] - start[1]) * distance,
    ];
    const [x, y] = gfx.viewport.toViewCoord(point[0] + 20, point[1]);
    return {
      at: [x + gfx.viewport.left, y + gfx.viewport.top] as const,
      onLine: connector.labelIncludesPoint(point),
      start: start[1],
      stored: connector.labelXYWH,
    };
  });

test("a viewer's board shows a connector's label on the path its note's measured size moved, takes a click there, and writes nothing", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await bensCard(page, 'viewer');
  await bensConnector(page, id);
  await page.evaluate(() => (window as Shown).__board?.fit([80, 80, 80, 80]));
  // The path starts at the bottom of the text this tab shows, below 60.
  await expect
    .poll(async () => (await labelled(page))?.start ?? 0)
    .toBeGreaterThan(STORED + 40);
  const before = await page.evaluate(() =>
    (window as Shown).__board?.snapshot()
  );
  const shown = await labelled(page);
  if (!shown) throw new Error('no connector');
  expect(shown.onLine).toBe(true);
  expect(shown.stored).toEqual([140, 218, 60, 24]);
  await page.mouse.click(...shown.at);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Shown).__board?.presence.selected())
    )
    .toEqual(['join']);
  // A write on a read channel would close it and open the room afresh.
  await page.waitForTimeout(3500);
  expect(
    await page.evaluate(() => (window as Shown).__board?.kept === true)
  ).toBe(true);
  expect(await page.evaluate(() => (window as Shown).__board?.snapshot())).toBe(
    before
  );
  expect(errors).toEqual([]);
});

test("an editor's board drags and edits a connector's label where the path its note's measured size moved shows it, and Undo takes the edit back", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await bensCard(page, 'editor');
  await page.evaluate(() => (window as Shown).__board?.fit([80, 80, 80, 80]));
  /** The note's height and the connector's label in Ben's tab. */
  const onBen = () =>
    page.evaluate((id) => {
      const { peer } = window as Shown;
      const block = peer?.document.getMap<YMap>('blocks').get(id);
      const join = peer?.elements().join as
        | { labelOffset: { distance: number }; text: string }
        | undefined;
      return {
        distance: join?.labelOffset.distance,
        h: (JSON.parse(String(block?.get('prop:xywh'))) as number[])[3],
        text: join?.text,
      };
    }, id);
  // As in the drag's test: this tab writes its text's height after 3 s and
  // Ben writes 60 back, so this tab shows its height with 60 stored, then
  // Ben adds the connector, its label placed for 60.
  await expect
    .poll(async () => (await onBen()).h, { timeout: 10_000 })
    .toBeGreaterThan(STORED + 40);
  await page.evaluate(
    ([id, xywh]) => {
      const { peer } = window as Shown;
      const block = peer?.document.getMap<YMap>('blocks').get(id);
      if (!(peer && block)) throw new Error('no note');
      peer.document.transact(() => block.set('prop:xywh', xywh));
    },
    [id, `[0,0,340,${STORED}]`] as const
  );
  await expect.poll(async () => (await measure(page))?.stored).toBe(STORED);
  await bensConnector(page, id);
  await expect
    .poll(async () => (await labelled(page))?.start ?? 0)
    .toBeGreaterThan(STORED + 40);
  const shown = await labelled(page);
  if (!shown) throw new Error('no connector');
  expect(shown.onLine).toBe(true);

  // A drag from the label moves it down its line, where it shows. (Its write
  // takes no Undo step, as upstream: the drag's end writes it outside one.)
  // From off the label, so the board sees the pointer arrive on it.
  await page.mouse.move(shown.at[0] + 100, shown.at[1]);
  await page.mouse.move(...shown.at, { steps: 4 });
  await page.mouse.down();
  await page.mouse.move(shown.at[0], shown.at[1] + 60, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await onBen()).distance ?? 0)
    .toBeGreaterThan(0.6);
  const moved = await labelled(page);
  if (!moved) throw new Error('no connector');
  expect(moved.onLine).toBe(true);

  // A double click on the label opens its editor; the text typed replaces it,
  // and Undo takes it back.
  await page.mouse.dblclick(...moved.at);
  await expect(page.locator('edgeless-connector-label-editor')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.closest('edgeless-connector-label-editor') !=
          null
      )
    )
    .toBe(true);
  await page.keyboard.type('joins');
  await page.keyboard.press('Escape');
  await expect(page.locator('edgeless-connector-label-editor')).toHaveCount(0);
  await expect.poll(async () => (await onBen()).text).toBe('joins');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await onBen()).text).toBe('feeds');
  expect((await labelled(page))?.onLine).toBe(true);
  expect(errors).toEqual([]);
});
