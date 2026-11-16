import { expect, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

// Epo 2026-10-17: a chart's, plot's or graph's block is a live map in the
// note's room. Two editors changing different fields of one chart at once
// both end with the merged chart; a peer's graph edit is drawn here from its
// elements, and nothing is written back (no stored picture, Epo 2026-11-16).
// The other editor is a headless peer in the note's mock room
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

/** The peer's figure `id` block map, read as JSON. */
const peerBlock = (page: Page, id: string) =>
  page.evaluate((id) => {
    const { document } = (window as unknown as { peer: Peer }).peer;
    const root = document.get('content') as unknown as {
      toDelta: () => { insert: { getAttribute: (key: string) => unknown } }[];
    };
    const node = root
      .toDelta()
      .map((op) => op.insert)
      .find((insert) => insert?.getAttribute?.('id') === id);
    const block = node?.getAttribute('block') as { toJSON: () => unknown };
    return block.toJSON();
  }, id);

test.describe('live figures', () => {
  test('two editors change different fields of one chart at once and both see the merged chart', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );
    await joinPeer(page, [chart]);
    const figure = editor.locator('[data-block-id="live-chart"]');
    await expect(figure).toBeVisible();
    await figure.hover();
    await figure.getByRole('button', { name: m.action_edit() }).click();
    const dialog = page.getByRole('dialog', { name: m.editor_chart() });
    await dialog
      .getByRole('textbox', { name: m.question_ui_title() })
      .fill('Revenue');
    // The peer rewrites the series while the dialog is open: the draft
    // follows it, keeping the title typed here.
    await page.evaluate(() => {
      const { document } = (window as unknown as { peer: Peer }).peer;
      const root = document.get('content') as unknown as {
        toDelta: () => { insert: { getAttribute: (key: string) => unknown } }[];
      };
      const node = root
        .toDelta()
        .map((op) => op.insert)
        .find((insert) => insert?.getAttribute?.('id') === 'live-chart');
      const block = node?.getAttribute('block') as {
        get: (key: string) => {
          get: (index: number) => {
            set: (key: string, value: unknown) => void;
          };
        };
      };
      block.get('series').get(0).set('values', [10, 20]);
    });
    const cell = dialog.getByRole('spinbutton', {
      name: m.question_ui_series_row({ name: 'Rain', number: 1 }),
    });
    await expect(cell).toHaveValue('10');
    await expect(
      dialog.getByRole('textbox', { name: m.question_ui_title() })
    ).toHaveValue('Revenue');
    await dialog.getByRole('button', { name: m.action_save() }).click();
    await expect(dialog).toBeHidden();
    const merged = {
      ...chart.block,
      series: [{ name: 'Rain', values: [10, 20] }],
      title: 'Revenue',
    };
    await expect.poll(() => peerBlock(page, 'live-chart')).toEqual(merged);
    await expect(figure).toContainText('Revenue');
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
    await page.evaluate(() => {
      const { document } = (window as unknown as { peer: Peer }).peer;
      const root = document.get('content') as unknown as {
        toDelta: () => { insert: { getAttribute: (key: string) => unknown } }[];
      };
      const node = root
        .toDelta()
        .map((op) => op.insert)
        .find((insert) => insert?.getAttribute?.('id') === 'live-graph');
      const block = node?.getAttribute('block') as {
        get: (key: string) => {
          get: (index: number) => {
            set: (key: string, value: unknown) => void;
          };
        };
      };
      block.get('elements').get(1).set('coords', [3, 2]);
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
