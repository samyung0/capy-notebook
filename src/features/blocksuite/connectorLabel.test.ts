import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { ConnectorElementView } from '@blocksuite/affine/gfx/connector';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { DisposableGroup } from '@blocksuite/affine/global/disposable';
import { Bound, type IVec } from '@blocksuite/affine/global/gfx';
import type { ConnectorElementModel } from '@blocksuite/affine/model';
import { BlockStdScope } from '@blocksuite/affine/std';
import {
  type DragEndContext,
  type DragMoveContext,
  type DragStartContext,
  type GfxController,
  type GfxPrimitiveElementModel,
  InteractivityIdentifier,
  InteractivityManager,
} from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
// BlockSuite's connector end handle, which its entry doesn't export.
import { EdgelessConnectorHandle } from '../../../vendor/blocksuite/affine/gfx/connector/src/components/connector-handle';
import { boardFirstState } from './boardFirstState';
import { unknownStore } from './boardUnknown';
import { openRoomStore } from './roomStore';

/* A connector's label on a shared canvas (vendor/blocksuite local change 63):
 * its place is stored, and only the tab whose own action moved it writes it. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
]);

/** A tab on the room: its document, its store, and the updates it wrote
 * itself (what it would send). */
function tab(state: Uint8Array, readonly = false) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, 'room');
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'room') sent.push(update);
  });
  const { store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    readonly,
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  return { doc, sent, store, surface };
}

/** The connector watcher works a microtask after a change. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The gesture this tab's board has under way, as BlockSuite's interactivity
 * manager mounted on `store` tracks it (a drag, a resize, a turn). */
function gestureOn(store: Store) {
  // Its keyboard listens on the page.
  vi.stubGlobal('document', new EventTarget());
  const interactivity = new BlockStdScope({
    extensions: [InteractivityManager],
    store,
  }).get(InteractivityIdentifier);
  interactivity.mounted();
  onTestFinished(() => interactivity.unmounted());
  return interactivity.activeInteraction$;
}

const shape = (x: number) => ({
  shapeType: 'rect',
  type: 'shape',
  xywh: `[${x},0,100,100]`,
});

/** A room holding two shapes joined by a labelled connector, as its maker's
 * tab leaves it. */
async function labelledBoard() {
  const maker = tab(boardFirstState());
  const from = maker.surface.addElement(shape(0));
  const to = maker.surface.addElement(shape(400));
  const connector = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [0, 0, 60, 24],
    mode: 0,
    source: { id: from },
    target: { id: to },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  return { connector, from, maker };
}

const labelOf = (
  { surface }: ReturnType<typeof tab>,
  id: string
): number[] | undefined =>
  (surface.getElementById(id) as ConnectorElementModel).labelXYWH;

it('opens a board holding a labelled connector and writes nothing', async () => {
  const { maker } = await labelledBoard();
  const state = Y.encodeStateAsUpdate(maker.doc);
  const editor = tab(state);
  const viewer = tab(state, true);
  await settled();
  expect(editor.sent).toEqual([]);
  expect(viewer.sent).toEqual([]);
  expect(editor.store.canUndo).toBe(false);
});

it("places the label with its maker's move, and the other tabs write nothing", async () => {
  const { connector, from, maker } = await labelledBoard();
  const state = Y.encodeStateAsUpdate(maker.doc);
  const editor = tab(state);
  const viewer = tab(state, true);
  // The editor has a step of its own to take back, then takes it back.
  const own = editor.surface.addElement(shape(800));
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(editor.doc), 'room');
  editor.store.undo();
  await settled();
  editor.sent.length = 0;
  const before = labelOf(maker, connector);

  // The maker moves a shape the connector hangs on: its own tab moves the label.
  const relay: Uint8Array[] = [];
  maker.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'room') relay.push(update);
  });
  maker.surface.updateElement(from, { xywh: '[0,300,100,100]' });
  await settled();
  expect(labelOf(maker, connector)).not.toEqual(before);
  for (const update of relay) {
    Y.applyUpdate(editor.doc, update, 'room');
    Y.applyUpdate(viewer.doc, update, 'room');
  }
  await settled();

  // The others show it where the maker's tab put it, and wrote nothing.
  expect(labelOf(editor, connector)).toEqual(labelOf(maker, connector));
  expect(labelOf(viewer, connector)).toEqual(labelOf(maker, connector));
  expect(editor.sent).toEqual([]);
  expect(viewer.sent).toEqual([]);
  // The editor's Undo and Redo are as they were: nothing new to undo, and the
  // step taken back can still be done again.
  expect(editor.store.canUndo).toBe(false);
  expect(editor.store.canRedo).toBe(true);
  editor.store.redo();
  expect(editor.surface.hasElementById(own)).toBe(true);
});

it("drags a connector with its free ends and label this tab's, writing each once at the end", async () => {
  const maker = tab(boardFirstState());
  const id = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [70, -12, 60, 24],
    mode: 0,
    source: { position: [0, 0] },
    target: { position: [200, 0] },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  const connector = maker.surface.getElementById(id) as ConnectorElementModel;
  // BlockSuite's drag hands the element's view the bound it started from and
  // the pointer's distance on every frame (local change 80).
  const view = new ConnectorElementView(connector, {} as GfxController);
  const start = Bound.deserialize(connector.xywh);
  maker.sent.length = 0;
  view.onDragStart({} as DragStartContext);
  for (const dy of [10, 20, 30]) {
    view.onDragMove({ currentBound: start, dx: 0, dy } as DragMoveContext);
    await settled();
  }
  expect(maker.sent).toEqual([]);
  expect(connector.source.position).toEqual([0, 30]);

  view.onDragEnd({} as DragEndContext);
  await settled();
  expect(maker.sent).toHaveLength(3);
  const stored = maker.surface.getElementById(id) as ConnectorElementModel;
  expect(stored.yMap.get('source')).toEqual({ position: [0, 30] });
  expect(stored.yMap.get('target')).toEqual({ position: [200, 30] });
  expect(stored.yMap.get('labelXYWH')).toEqual([70, 18, 60, 24]);
});

// Local change 83: a labelled connector hanging on a shape in the middle of a
// drag wrote its label at every frame (about 20 B a label a frame, on any
// board). Fails if a frame writes, if the labels are not written inside the
// change that ends the drag (Undo would take them back apart from it), or if
// a resize ending where it began writes them (a peer's place stored
// meanwhile would be lost, in an Undo step of its own) or leaves them this
// tab's (a later one would not show).
it("holds the labels hanging on a shape mid-gesture this tab's, and writes each once as it ends, taken back with it", async () => {
  const maker = tab(boardFirstState());
  const gesture = gestureOn(maker.store);
  const from = maker.surface.addElement(shape(0));
  const to = maker.surface.addElement(shape(400));
  const connectors = [0, 1].map(() =>
    maker.surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode: 0,
      source: { id: from },
      target: { id: to },
      text: new Y.Text('feeds'),
      type: 'connector',
    })
  );
  await settled();
  const before = connectors.map((id) => labelOf(maker, id));
  const moving = maker.surface.getElementById(from) as GfxPrimitiveElementModel;
  maker.store.captureSync();
  maker.sent.length = 0;
  // BlockSuite's drag stashes the shape's box and sets it on every frame.
  gesture.value = { elements: [moving], type: 'move' };
  moving.stash('xywh');
  for (const y of [100, 200, 300]) {
    moving.xywh = `[0,${y},100,100]`;
    await settled();
  }
  expect(maker.sent).toEqual([]);
  const shown = connectors.map((id) => labelOf(maker, id));
  expect(shown).not.toEqual(before);

  // The drag's end: the gesture is over, then a change stores the box, and
  // the labels inside it.
  gesture.value = null;
  maker.store.transact(() => moving.pop('xywh'));
  expect(maker.sent).toHaveLength(3);
  const stored = () =>
    connectors.map((id) =>
      (maker.surface.getElementById(id) as ConnectorElementModel).yMap.get(
        'labelXYWH'
      )
    );
  expect(stored()).toEqual(shown);
  maker.store.captureSync();
  maker.store.undo();
  await settled();
  expect(connectors.map((id) => labelOf(maker, id))).toEqual(before);

  // A resize that ends where it began stores nothing: a peer's place, stored
  // meanwhile, stands, and the labels are this tab's no more.
  await settled();
  const peer = tab(Y.encodeStateAsUpdate(maker.doc));
  maker.sent.length = 0;
  gesture.value = { elements: [moving], type: 'resize' };
  moving.stash('xywh');
  moving.xywh = '[0,0,300,300]';
  await settled();
  peer.surface.updateElement(connectors[0], { labelXYWH: [5, 5, 60, 24] });
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(peer.doc), 'room');
  moving.xywh = '[0,0,100,100]';
  await settled();
  gesture.value = null;
  maker.store.transact(() => moving.pop('xywh'));
  await settled();
  expect(maker.sent).toEqual([]);
  expect(labelOf(maker, connectors[0])).toEqual([5, 5, 60, 24]);
  peer.surface.updateElement(connectors[1], { labelXYWH: [6, 6, 60, 24] });
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(peer.doc), 'room');
  expect(labelOf(maker, connectors[1])).toEqual([6, 6, 60, 24]);
});

// Review of local change 80: a drag stashed a bound end too, which `moveTo`
// never changes, and wrote it back at the end. Fails if a peer's re-attach
// made mid-drag is undone by the drag's end, or if an end a peer frees
// mid-drag is stored at every frame after.
it("keeps a peer's re-attach of a bound end made while this tab drags the connector, and holds an end a peer frees this tab's", async () => {
  const maker = tab(boardFirstState());
  const [a, b] = [
    maker.surface.addElement(shape(0)),
    maker.surface.addElement(shape(400)),
  ];
  const id = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [0, 0, 60, 24],
    mode: 0,
    source: { id: a },
    target: { position: [200, 300] },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  const peer = tab(Y.encodeStateAsUpdate(maker.doc));
  const connector = maker.surface.getElementById(id) as ConnectorElementModel;
  const view = new ConnectorElementView(connector, {} as GfxController);
  const start = Bound.deserialize(connector.xywh);
  view.onDragStart({} as DragStartContext);
  view.onDragMove({ currentBound: start, dx: 0, dy: 10 } as DragMoveContext);
  peer.surface.updateElement(id, { source: { id: b } });
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(peer.doc), 'room');
  view.onDragEnd({} as DragEndContext);
  await settled();
  expect(connector.yMap.get('source')).toEqual({ id: b });
  expect(connector.yMap.get('target')).toEqual({ position: [200, 310] });

  // A peer frees the bound end mid-drag: the frames after write nothing.
  await settled();
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(maker.doc), 'room');
  const again = Bound.deserialize(connector.xywh);
  view.onDragStart({} as DragStartContext);
  peer.surface.updateElement(id, { source: { position: [0, 0] } });
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(peer.doc), 'room');
  await settled();
  maker.sent.length = 0;
  for (const dy of [10, 20, 30])
    view.onDragMove({ currentBound: again, dx: 0, dy } as DragMoveContext);
  await settled();
  expect(maker.sent).toEqual([]);
  const shown = connector.source;
  expect(shown).not.toEqual({ position: [0, 0] });
  view.onDragEnd({} as DragEndContext);
  await settled();
  expect(connector.yMap.get('source')).toEqual(shown);
});

// Review of local change 83 (local change 85): an end dragged by its handle
// was stored at every pointer move, and the label the watcher places on its
// path with it (about 20 B a frame). Fails if a move writes, if the end and
// label are not written once, in one change Undo takes back, or if a
// cancelled pointer leaves them this tab's.
it("drags a connector's end by its handle with its label this tab's, writing both once as the pointer is up", async () => {
  const maker = tab(boardFirstState());
  const from = maker.surface.addElement(shape(0));
  const id = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [0, 0, 60, 24],
    mode: 0,
    source: { id: from },
    target: { position: [400, 50] },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  const connector = maker.surface.getElementById(id) as ConnectorElementModel;
  const before = { label: labelOf(maker, id), target: connector.target };
  // The handle as it stands, unrendered: the pointer's moves land on the page,
  // each at the model point under it, attached to nothing.
  const page = new EventTarget();
  vi.stubGlobal('document', page);
  const handle = Object.create(EdgelessConnectorHandle.prototype, {
    _bindEvent: { value: () => {} },
    _disposables: { value: new DisposableGroup(), writable: true },
    connectionOverlay: {
      value: { renderConnector: (point: IVec) => ({ position: point }) },
    },
    connector: { value: connector },
    doc: { value: maker.store },
    gfx: {
      value: {
        viewport: { toModelCoordFromClientCoord: (point: IVec) => point },
      },
    },
    requestUpdate: { value: () => {} },
    slots: { value: { elementResizeEnd: { next: () => {} } } },
  }) as { _capPointerDown: (e: Event, end: 'source' | 'target') => void };
  maker.store.captureSync();
  maker.sent.length = 0;
  handle._capPointerDown(new Event('pointerdown'), 'target');
  for (const y of [100, 200, 300]) {
    page.dispatchEvent(Object.assign(new Event('pointermove'), { x: 400, y }));
    await settled();
  }
  expect(maker.sent).toEqual([]);
  const shown = labelOf(maker, id);
  expect(shown).not.toEqual(before.label);

  page.dispatchEvent(new Event('pointerup'));
  await settled();
  expect(maker.sent).toHaveLength(1);
  expect(connector.yMap.get('target')).toEqual({ position: [400, 300] });
  expect(connector.yMap.get('labelXYWH')).toEqual(shown);
  maker.store.undo();
  await settled();
  expect(connector.target).toEqual(before.target);
  expect(labelOf(maker, id)).toEqual(before.label);

  // A cancelled pointer ends it as a release does.
  maker.sent.length = 0;
  handle._capPointerDown(new Event('pointerdown'), 'target');
  page.dispatchEvent(
    Object.assign(new Event('pointermove'), { x: 500, y: 50 })
  );
  await settled();
  expect(maker.sent).toEqual([]);
  page.dispatchEvent(new Event('pointercancel'));
  await settled();
  expect(maker.sent).toHaveLength(1);
  expect(connector.yMap.get('target')).toEqual({ position: [500, 50] });
  page.dispatchEvent(new Event('pointerup'));
  await settled();
  expect(maker.sent).toHaveLength(1);
});

it('takes a move back with its label, and can do it again', async () => {
  const { connector, from, maker } = await labelledBoard();
  const before = labelOf(maker, connector);
  maker.store.captureSync();
  maker.surface.updateElement(from, { xywh: '[0,300,100,100]' });
  await settled();
  const moved = labelOf(maker, connector);
  expect(moved).not.toEqual(before);
  maker.store.undo();
  await settled();
  expect(labelOf(maker, connector)).toEqual(before);
  expect(maker.store.canRedo).toBe(true);
  maker.store.redo();
  await settled();
  expect(labelOf(maker, connector)).toEqual(moved);
});
