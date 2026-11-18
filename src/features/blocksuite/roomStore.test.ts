import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { Text } from '@blocksuite/affine/store';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { boardFirstState } from './boardFirstState';
import { unknownStore } from './boardUnknown';
import { BLOCKS_ROOT, openRoomStore } from './roomStore';

/* The canvas's store over its room's document, as `mountDrawingBoard` opens
 * it: BlockSuite's store and canvas model, without the editor's view. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  BrushStoreExtension,
]);

/** A room's document as the server seeds it. */
function room() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState(), 'room');
  return doc;
}

function open(doc: Y.Doc, readonly = false) {
  return openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    readonly,
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
}

const surfaceOf = (store: ReturnType<typeof open>['store']) =>
  store.getModelsByFlavour('affine:surface')[0] as SurfaceBlockModel;

const stroke = {
  color: '#000000',
  lineWidth: 4,
  points: [
    [0, 0],
    [10, 10],
  ],
  type: 'brush',
  xywh: '[0,0,10,10]',
};

it("opens the room's first state and writes nothing", () => {
  const doc = room();
  const before = Y.encodeStateAsUpdate(doc);
  const { dispose, store } = open(doc);
  expect(store.root?.flavour).toBe('affine:page');
  expect(surfaceOf(store).id).toBe('surface');
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  dispose();
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
});

it('writes block edits into the room document alone', () => {
  const doc = room();
  const { dispose, store } = open(doc);
  const note = store.addBlock(
    'affine:note',
    { xywh: '[0,0,200,80]' },
    store.root
  );
  store.addBlock('affine:paragraph', { text: new Text('Light') }, note);
  surfaceOf(store).addElement(stroke);
  expect([...doc.share.keys()]).toEqual([BLOCKS_ROOT]);
  expect(doc.getMap(BLOCKS_ROOT).size).toBe(4);
  dispose();
});

it("shows a peer's stroke and leaves it out of this tab's undo", () => {
  const doc = room();
  const { dispose, store } = open(doc);
  const peerDoc = room();
  const peer = open(peerDoc);
  const id = surfaceOf(peer.store).addElement(stroke);
  // The room hands a peer's update over under an origin of its own.
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc), 'room');
  expect(surfaceOf(store).getElementById(id)?.type).toBe('brush');
  expect(store.canUndo).toBe(false);
  peer.dispose();
  dispose();
});

it('undoes its own edits after the client id changes', () => {
  const doc = room();
  const { dispose, store } = open(doc);
  // The room's JOIN may hand out another id after the store was built (a
  // refused id is replaced at once, Q475).
  doc.clientID = 4242;
  const surface = surfaceOf(store);
  const id = surface.addElement(stroke);
  expect(surface.hasElementById(id)).toBe(true);
  expect(store.canUndo).toBe(true);
  store.undo();
  expect(surface.hasElementById(id)).toBe(false);
  dispose();
});

it('opens read-only for a viewer and writes nothing', () => {
  const doc = room();
  const before = Y.encodeStateAsUpdate(doc);
  const { dispose, store } = open(doc, true);
  expect(store.readonly).toBe(true);
  expect(surfaceOf(store).id).toBe('surface');
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  dispose();
});

it("leaves no undo manager on the room's document when it closes", () => {
  const doc = room();
  const watching = () =>
    (
      doc as unknown as { _observers: Map<string, Set<unknown>> }
    )._observers.get('afterTransaction')?.size ?? 0;
  const before = watching();
  const { dispose, store } = open(doc);
  surfaceOf(store).addElement(stroke);
  expect(watching()).toBeGreaterThan(before);
  dispose();
  expect(watching()).toBe(before);
});
