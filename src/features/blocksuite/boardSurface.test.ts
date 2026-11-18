import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import type { GfxBlockElementModel } from '@blocksuite/affine/std/gfx';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { boardFirstState } from './boardFirstState';
import { openRoomStore } from './roomStore';

/* A note's `surface`, which the layer sort reads in every compare, is found
 * once per store (vendor/blocksuite local change 67) and follows the store's
 * surface block as it goes and comes. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
]);

it("finds the store's surface, and another once it is replaced", () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState(), 'room');
  const { dispose, store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    readonly: false,
    storeExtensions: stores.get('store'),
  });
  const root = store.root;
  if (!root) throw new Error('no root');
  const note = store.getModelById(
    store.addBlock('affine:note', { xywh: '[0,0,200,80]' }, root)
  ) as GfxBlockElementModel;
  const [first] = store.getModelsByFlavour('affine:surface');
  expect(note.surface).toBe(first);
  expect(note.surface).toBe(first);

  store.deleteBlock(first);
  expect(note.surface).toBeNull();
  const again = store.getModelById(store.addBlock('affine:surface', {}, root));
  expect(again).not.toBeNull();
  expect(note.surface).toBe(again);
  dispose();
});
