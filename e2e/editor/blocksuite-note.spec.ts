import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';

/**
 * The BlockSuite note on MSW (todo-blocksuite-spike.md, step 1 piece 3): a
 * note in the blocks layout opens from its seeded room without writing to it,
 * edits sync with another participant of the room (a headless peer: MSW's
 * rooms live in the page), Undo reverts the typing, and pastes go through our
 * converters. Runs only with the flag on:
 * `VITE_DOCUMENT_LAYOUT=blocks pnpm e2e:msw:editor blocksuite-note`.
 */

// biome-ignore lint/suspicious/noSkippedTests: BlockSuite notes exist only on a blocks-layout stack.
test.skip(
  process.env.VITE_DOCUMENT_LAYOUT !== 'blocks',
  'needs VITE_DOCUMENT_LAYOUT=blocks'
);

const COLLABORATION = '/src/mocks/collaboration.ts';
const THIRD = `${EDITOR_NOTE.id}:third`;

async function openNote(page: Page) {
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${EDITOR_NOTE.id}&mode=edit`
  );
  const note = page.locator('[data-blocksuite-note]');
  // The first open transforms BlockSuite's sources.
  await expect(note.getByText(EDITOR_NOTE.thirdParagraph)).toBeVisible({
    timeout: 45_000,
  });
  return note;
}

/** The caret at the end of a block's text. */
async function caretAtEnd(page: Page, text: Locator) {
  const box = (await text.boundingBox())!;
  await text.click({ position: { x: box.width - 1, y: box.height / 2 } });
  await page.keyboard.press('End');
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
    { id: EDITOR_NOTE.id, path: COLLABORATION }
  );
}

type PeerDoc = import('yjs').Doc;

/** A block's text as the peer holds it. */
const peerText = (page: Page, block: string) =>
  page.evaluate((block) => {
    const { peer } = window as unknown as { peer: PeerDoc };
    const yBlock = peer.getMap('blocks').get(block) as
      | import('yjs').Map<unknown>
      | undefined;
    return yBlock?.get('prop:text')?.toString();
  }, block);

/** The peer's blocks with `text`, as `flavour` (and `variant`). */
const peerFlavours = (page: Page, text: string) =>
  page.evaluate((text) => {
    const { peer } = window as unknown as { peer: PeerDoc };
    const blocks = peer.getMap('blocks') as import('yjs').Map<
      import('yjs').Map<unknown>
    >;
    const found: string[] = [];
    // A block's id is its key in the map (no `sys:id`).
    for (const [id, block] of blocks.entries()) {
      if (!String(block.get('prop:text') ?? '').includes(text)) continue;
      found.push(String(block.get('sys:flavour')));
      // A callout's text sits in its paragraphs.
      for (const parent of blocks.values())
        if (
          (parent.get('sys:children') as import('yjs').Array<string>)
            .toArray()
            .includes(id)
        )
          found.push(
            `${parent.get('sys:flavour')}${parent.get('prop:variant') ? `:${parent.get('prop:variant')}` : ''}`
          );
    }
    return found;
  }, text);

test.describe('BlockSuite note', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('opens the seeded room without writing to it', async ({ page }) => {
    const note = await openNote(page);
    await expect(note.getByText(EDITOR_NOTE.headingText)).toBeVisible();
    await expect(note.locator('affine-paragraph')).toHaveCount(4);
    // Every struct in the room is the seed's.
    const writers = await page.evaluate(
      async ({ id, path }) => {
        const { mockMaterialRoom, rooms } = (await import(
          path
        )) as typeof import('../../src/mocks/collaboration');
        const room = rooms.get(mockMaterialRoom(id))!;
        const [editor] = room.participants;
        return {
          awareness: Object.keys(editor.awareness?.getLocalState() ?? {}),
          clients: (
            room.document as unknown as { store: { clients: Map<number, []> } }
          ).store.clients.size,
          layout: room.layout,
        };
      },
      { id: EDITOR_NOTE.id, path: COLLABORATION }
    );
    // BlockSuite's selections ride on the room's awareness, without its
    // random `color`.
    expect(writers).toEqual({
      awareness: ['selectionV2'],
      clients: 1,
      layout: 'blocks',
    });
  });

  test('typing syncs both ways and Undo reverts it', async ({ page }) => {
    const note = await openNote(page);
    await joinPeer(page);
    await caretAtEnd(page, note.getByText(EDITOR_NOTE.thirdParagraph));
    await page.keyboard.type(' delta');
    await expect(note.getByText('Third paragraph gamma delta')).toBeVisible();
    await expect
      .poll(() => peerText(page, THIRD))
      .toBe('Third paragraph gamma delta');

    // The peer's typing shows in the editor.
    await page.evaluate((block) => {
      const { peer } = window as unknown as { peer: PeerDoc };
      const yBlock = peer.getMap('blocks').get(block) as import('yjs').Map<
        import('yjs').Text
      >;
      yBlock.get('prop:text')!.insert(0, 'Peer: ');
    }, `${EDITOR_NOTE.id}:first`);
    await expect(note.getByText('Peer: First paragraph alpha')).toBeVisible();

    // Undo takes back this tab's typing only.
    await page.keyboard.press('ControlOrMeta+Z');
    await expect
      .poll(() => peerText(page, THIRD))
      .toBe(EDITOR_NOTE.thirdParagraph);
    await expect(note.getByText('Peer: First paragraph alpha')).toBeVisible();
  });

  test('the caret follows its own blocks while another block renders', async ({
    page,
  }) => {
    const note = await openNote(page);
    // Another block whose render never settles: the range sync waits only
    // for the blocks it reads (vendor/blocksuite/README.md, local change 7).
    await page.evaluate((block) => {
      const element = document.querySelector(`[data-block-id="${block}"]`)!;
      Object.defineProperty(element, 'updateComplete', {
        get: () => new Promise(() => {}),
      });
    }, `${EDITOR_NOTE.id}:first`);
    await caretAtEnd(page, note.getByText(EDITOR_NOTE.thirdParagraph));
    await page.keyboard.type(' delta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('next line');
    await expect(note.getByText('Third paragraph gamma delta')).toBeVisible();
    await expect(
      note.locator('affine-paragraph', { hasText: /^next line$/ })
    ).toHaveCount(1);
  });

  test('pasted Markdown becomes blocks', async ({ page }) => {
    const note = await openNote(page);
    await joinPeer(page);
    await caretAtEnd(page, note.getByText(EDITOR_NOTE.thirdParagraph));
    await page.keyboard.press('Enter');
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        '## Pasted heading\n\n- first item\n- second item'
      )
    );
    await page.keyboard.press('ControlOrMeta+V');
    await expect(note.locator('affine-list')).toHaveCount(2);
    await expect(note.locator('affine-list').first()).toContainText(
      'first item'
    );
    expect(await peerFlavours(page, 'Pasted heading')).toEqual([
      'affine:paragraph',
      'affine:note',
    ]);
    expect(await peerFlavours(page, 'second item')).toEqual([
      'affine:list',
      'affine:note',
    ]);
    // Our converter's blocks (BlockSuite's own Markdown paste mints nanoids).
    const id = await page.evaluate(() => {
      const { peer } = window as unknown as { peer: PeerDoc };
      const blocks = peer.getMap('blocks') as import('yjs').Map<
        import('yjs').Map<unknown>
      >;
      return [...blocks.entries()].find(([, block]) =>
        String(block.get('prop:text')).includes('first item')
      )?.[0];
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('a chat answer pastes with its callout', async ({ page }) => {
    const note = await openNote(page);
    await joinPeer(page);
    await page
      .getByText('OpenUI: tabs, steps + reveals', { exact: true })
      .first()
      .click();
    await expect(page.locator('[data-ui]').first()).toBeVisible();
    // The whole answer, copied with the keyboard (answerCopy.ts).
    await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('[data-ui]')].filter(
        (element) => !element.parentElement?.closest('[data-ui]')
      );
      const range = document.createRange();
      range.setStartBefore(blocks[0]);
      range.setEndAfter(blocks.at(-1)!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.press('ControlOrMeta+C');
    await caretAtEnd(page, note.getByText(EDITOR_NOTE.thirdParagraph));
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+V');

    await expect(note.locator('affine-callout')).toContainText(
      'Energy required'
    );
    const flavours = await peerFlavours(page, 'Energy required');
    expect(flavours[0]).toMatch(/^affine:(paragraph|list)$/);
    expect(flavours[1]).toMatch(/^affine:callout:/);
  });
});
