import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Text } from '@blocksuite/affine/store';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import {
  applyValue,
  BLOCKS_ROOT,
  NOTE_ID,
} from '@/features/notes/blocksuite/layout';
import { keepIdMiddleware } from './clipboard';
import { openRoomStore } from './roomStore';

const TESTDATA = fileURLToPath(
  new URL('../../../server/internal/materialdoc/testdata/', import.meta.url)
);

/** A testdata value without its unsaved refs' `pending` bodies, which no
 * stored note holds. */
function value(file: string): MaterialValue {
  const parsed = JSON.parse(readFileSync(`${TESTDATA}${file}`, 'utf8')) as {
    value: MaterialValue;
  };
  return parsed.value.map(
    ({ pending: _, ...block }) => block as MaterialElement
  );
}

const VALUES: [string, MaterialValue][] = [
  ['every-block-note.json', value('every-block-note.json')],
  ['empty', []],
  ...readdirSync(`${TESTDATA}blocks`).map((file): [string, MaterialValue] => [
    file,
    value(`blocks/${file}`),
  ]),
];

function seeded(material: MaterialValue) {
  const doc = new Y.Doc();
  applyValue(doc, material);
  return doc;
}

function open(doc: Y.Doc) {
  return openRoomStore({ awareness: new Awareness(doc), doc, id: 'note-1' });
}

describe('the room store', () => {
  it.each(VALUES)(
    'opens %s over the room doc and writes nothing',
    (_, material) => {
      const doc = seeded(material);
      const before = Y.encodeStateAsUpdate(doc);
      const { dispose, store } = open(doc);
      const blocks = doc.getMap(BLOCKS_ROOT);
      // Every block of the room has its model.
      expect(
        store
          .getAllModels()
          .map((model) => model.id)
          .sort()
      ).toEqual([...blocks.keys()].sort());
      expect(store.root?.flavour).toBe('affine:page');
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      dispose();
    }
  );

  it('undoes its own edits after the client id changes', () => {
    const doc = seeded([
      { children: [{ text: 'base' }], id: 'body', type: 'p' },
    ]);
    const { dispose, store } = open(doc);
    const text = () => store.getModelById('body')?.text as Text;
    // A refused id is replaced at once (Q475), after the store was built.
    doc.clientID = 4242;
    store.transact(() => text().insert('!', 4));
    expect(text().toString()).toBe('base!');
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(text().toString()).toBe('base');
    dispose();
  });
});

describe('the paste id middleware', () => {
  it('keeps a free id and mints one for a taken id', async () => {
    const doc = seeded([
      { children: [{ text: 'base' }], id: 'body', type: 'p' },
    ]);
    const { dispose, store } = open(doc);
    const paragraph = (id: string, text: string) => ({
      children: [],
      flavour: 'affine:paragraph',
      id,
      props: {
        text: { '$blocksuite:internal:text$': true, delta: [{ insert: text }] },
        type: 'text',
      },
      type: 'block' as const,
    });
    const job = store.getTransformer([keepIdMiddleware(store)]);
    await job.snapshotToSlice(
      {
        content: [paragraph('cut-block', 'moved'), paragraph('body', 'copy')],
        pageId: 'note-1',
        type: 'slice',
        workspaceId: 'note-1',
      },
      store,
      NOTE_ID,
      1
    );
    const children = store.getModelById(NOTE_ID)?.children ?? [];
    expect(children.map((child) => child.text?.toString())).toEqual([
      'base',
      'moved',
      'copy',
    ]);
    expect(children[1].id).toBe('cut-block');
    expect(children[2].id).not.toBe('body');
    dispose();
  });
});
