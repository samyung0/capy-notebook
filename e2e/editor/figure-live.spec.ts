import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

// A chart's, plot's or graph's block is the figure map a quiz room holds
// (Epo 2026-11-16, D15): fields, chart cells and graph elements each their
// own entry. The note's chart and graph dialog is live, as a quiz's is: each
// change reaches the room as it is made, a peer's change reaches the open
// dialog, Done only closes. A peer's graph edit is drawn here from its
// elements, and nothing is written back (no stored picture). The other
// editor is a headless peer in the note's mock room
// (src/mocks/collaboration.ts).

type Peer = ReturnType<
  typeof import('../../src/mocks/collaboration').mockNotePeer
>;

const chart = {
  block: {
    kind: 'bar',
    labels: ['Jan', 'Feb'],
    series: [{ name: 'Rain', values: [1, 2] }],
    title: 'Sales',
    type: 'chart',
  },
  children: [{ text: '' }],
  id: 'live-chart',
  type: 'chart',
};

const graph = {
  block: {
    board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
    description: 'A segment from A to B',
    elements: [
      { coords: [0, 0], id: 'p1', name: 'A', type: 'point' },
      { coords: [1, 1], id: 'p2', name: 'B', type: 'point' },
      { id: 's1', points: ['p1', 'p2'], type: 'segment' },
    ],
    height: 190,
    type: 'graph',
    width: 320,
  },
  children: [{ text: '' }],
  id: 'live-graph',
  type: 'graph',
};

/** Another editor of the note, headless in its mock room, adding `blocks`. */
async function joinPeer(page: Page, blocks: unknown[]) {
  await page.evaluate(
    async ({ id, blocks }) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockNotePeer } = (await import(
        modulePath
      )) as typeof import('../../src/mocks/collaboration');
      const peer = mockNotePeer(id);
      peer.append(blocks as never);
      Object.assign(window, { peer });
    },
    { blocks, id: EDITOR_NOTE.id }
  );
}

type Figures = typeof import('../../src/features/figures/figureMap');

/** The peer's figure `id` as its plain block. */
const peerBlock = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const modulePath = '/src/features/figures/figureMap.ts';
    const { heldBlock } = (await import(modulePath)) as Figures;
    const { document } = (window as unknown as { peer: Peer }).peer;
    const root = document.get('content') as unknown as {
      toDelta: () => { insert: { getAttribute: (key: string) => unknown } }[];
    };
    const node = root
      .toDelta()
      .map((op) => op.insert)
      .find((insert) => insert?.getAttribute?.('id') === id);
    return heldBlock(
      node?.getAttribute('block') as Parameters<typeof heldBlock>[0],
      node?.getAttribute('type') as Parameters<typeof heldBlock>[1]
    );
  }, id);

/** The peer writes one entry of its figure `id` through the figure map's
 * one-entry writers: a chart cell (by place) or a graph element. */
const peerWrite = (
  page: Page,
  id: string,
  write:
    | { cell: [number, number, number] }
    | { element: Record<string, unknown> }
) =>
  page.evaluate(
    async ({ id, write }) => {
      const modulePath = '/src/features/figures/figureMap.ts';
      const figures = (await import(modulePath)) as Figures;
      const { document } = (window as unknown as { peer: Peer }).peer;
      const root = document.get('content') as unknown as {
        toDelta: () => { insert: { getAttribute: (key: string) => unknown } }[];
      };
      const node = root
        .toDelta()
        .map((op) => op.insert)
        .find((insert) => insert?.getAttribute?.('id') === id);
      const map = node?.getAttribute('block') as Parameters<
        typeof figures.readFigure
      >[0];
      document.transact(() => {
        if ('element' in write) {
          figures.setElement(map, write.element as never);
          return;
        }
        const held = figures.readFigure(map, 'chart');
        if (!held) throw new Error('No chart');
        const [series, label, value] = write.cell;
        figures.setChartCell(
          map,
          held.series[series],
          held.labels[label],
          value
        );
      });
    },
    { id, write }
  );

async function openDialog(page: Page, id: string, name: string) {
  const figure = page.locator(`[data-block-id="${id}"]`);
  await expect(figure).toBeVisible();
  await figure.hover();
  await figure.getByRole('button', { name: m.action_edit() }).click();
  const dialog = page.getByRole('dialog', { name });
  await expect(
    dialog.getByRole('button', { name: m.drawing_board_done() })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: m.action_save() })
  ).toHaveCount(0);
  return { dialog, figure };
}

test.describe('live figures', () => {
  test('two editors change different fields of one chart at once and both see the merged chart', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.thirdParagraph);
    await joinPeer(page, [chart]);
    const { dialog, figure } = await openDialog(
      page,
      'live-chart',
      m.question_ui_chart()
    );
    const title = dialog.getByRole('textbox', { name: m.question_ui_title() });
    await title.fill('Revenue');
    await title.press('Tab');
    // The title reached the room as it was left, with no Save.
    await expect
      .poll(() => peerBlock(page, 'live-chart'))
      .toMatchObject({ title: 'Revenue' });
    // The peer changes a cell while the dialog is open: it shows here.
    await peerWrite(page, 'live-chart', { cell: [0, 0, 10] });
    await expect(
      dialog.getByRole('spinbutton', {
        name: m.question_ui_series_row({ name: 'Rain', number: 1 }),
      })
    ).toHaveValue('10');
    await expect(title).toHaveValue('Revenue');
    await dialog.getByRole('button', { name: m.drawing_board_done() }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => peerBlock(page, 'live-chart'))
      .toEqual({
        ...chart.block,
        series: [{ name: 'Rain', values: [10, 2] }],
        title: 'Revenue',
      });
    await expect(figure).toContainText('Revenue');
  });

  test('a typed graph row reaches the peer as it is typed, and a peer edit reaches the open dialog', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.thirdParagraph);
    await joinPeer(page, [graph]);
    const { dialog } = await openDialog(
      page,
      'live-graph',
      m.question_ui_graph()
    );
    const rows = dialog.locator('math-field');
    await rows.last().click();
    // MathLive takes the keyboard a moment after the click.
    await page.waitForTimeout(250);
    await page.keyboard.type('C=(2,2)');
    await expect
      .poll(async () =>
        (
          (await peerBlock(page, 'live-graph')) as typeof graph.block
        ).elements.find((element) => element.name === 'C')
      )
      .toMatchObject({ coords: [2, 2], type: 'point' });
    await peerWrite(page, 'live-graph', {
      element: { coords: [3, 2], id: 'p2', name: 'B', type: 'point' },
    });
    await expect(rows.nth(1)).toHaveJSProperty('value', 'B=\\left(3,2\\right)');
    await dialog.getByRole('button', { name: m.drawing_board_done() }).click();
    await expect(dialog).toBeHidden();
  });

  test("a peer's graph edit is drawn here and nothing is written back", async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );
    await joinPeer(page, [graph]);
    const drawn = editor
      .locator('[data-block-id="live-graph"]')
      .getByRole('img', { name: graph.block.description });
    await expect(drawn).toBeVisible();
    // The peer moves B.
    await peerWrite(page, 'live-graph', {
      element: { coords: [3, 2], id: 'p2', name: 'B', type: 'point' },
    });
    await page.evaluate(() => {
      const { document } = (window as unknown as { peer: Peer }).peer;
      Object.assign(window, { updates: 0 });
      document.on('update', () => {
        (window as unknown as { updates: number }).updates += 1;
      });
    });
    await expect(drawn).toBeVisible();
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(
        () => (window as unknown as { updates: number }).updates
      )
    ).toBe(0);
    const held = (await peerBlock(page, 'live-graph')) as typeof graph.block;
    expect(held.elements[1].coords).toEqual([3, 2]);
  });
});
