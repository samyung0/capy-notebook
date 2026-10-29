import { readFileSync } from 'node:fs';
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
import { valueSnapshots } from '@/features/notes/blocksuite/pasteBlocks';
import { openRoomStore } from './roomStore';

/* The trimmed block map (vendor/blocksuite/README.md, local change 9): a
 * yBlock holds no `sys:id` (its key is its id) and no `sys:version`, and the
 * store neither needs them to open a note nor writes them back. */

const NOTE = fileURLToPath(
  new URL(
    '../../../server/internal/materialdoc/testdata/every-block-note.json',
    import.meta.url
  )
);

function seeded() {
  const { value } = JSON.parse(readFileSync(NOTE, 'utf8')) as {
    value: MaterialValue;
  };
  const doc = new Y.Doc();
  applyValue(
    doc,
    value.map(({ pending: _, ...block }) => block as MaterialElement)
  );
  return doc;
}

/** Every `sys:*` key held by a block. */
function sysKeys(doc: Y.Doc) {
  const keys = new Set<string>();
  for (const yBlock of doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT).values())
    for (const key of yBlock.keys()) if (key.startsWith('sys:')) keys.add(key);
  return [...keys].sort();
}

describe('the trimmed block map', () => {
  it('opens, types, adds, pastes and undoes without sys:id or sys:version', async () => {
    const doc = seeded();
    expect(sysKeys(doc)).toEqual(['sys:children', 'sys:flavour']);
    const before = Y.encodeStateVector(doc);
    const { dispose, store } = openRoomStore({
      awareness: new Awareness(doc),
      doc,
      id: 'note-1',
    });
    // Every block has its model and the open wrote nothing.
    const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT);
    expect(
      store
        .getAllModels()
        .map((model) => model.id)
        .sort()
    ).toEqual([...blocks.keys()].sort());
    expect(store.root?.id).toBe('root');
    expect(Y.encodeStateVector(doc)).toEqual(before);

    const paragraph = store
      .getAllModels()
      .find((model) => model.flavour === 'affine:paragraph' && model.text);
    if (!paragraph) throw new Error('The note holds no paragraph');
    store.transact(() => (paragraph.text as Text).insert('x', 0));
    store.captureSync();
    const added = store.addBlock('affine:paragraph', {}, NOTE_ID);
    store.captureSync();
    await store.getTransformer().snapshotToSlice(
      {
        content: valueSnapshots([
          { children: [{ text: 'pasted' }], id: 'p', type: 'p' },
          {
            children: [{ text: 'item' }],
            id: 'l',
            indent: 1,
            listStyleType: 'disc',
            type: 'p',
          },
        ]),
        pageId: 'note-1',
        type: 'slice',
        workspaceId: 'note-1',
      },
      store,
      NOTE_ID,
      0
    );
    const notes = store.getModelById(NOTE_ID)?.children ?? [];
    expect(notes[0].text?.toString()).toBe('pasted');
    expect(notes.at(-1)?.id).toBe(added);
    expect(sysKeys(doc)).toEqual(['sys:children', 'sys:flavour']);

    store.undo();
    store.undo();
    store.undo();
    expect(paragraph.text?.toString().startsWith('x')).toBe(false);
    expect(blocks.has(added)).toBe(false);
    expect(sysKeys(doc)).toEqual(['sys:children', 'sys:flavour']);
    dispose();
  });
});
