import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import {
  autoArrangeElementsCommand,
  DefaultTool,
  EdgelessCRUDExtension,
  EdgelessCRUDIdentifier,
  type SurfaceBlockModel,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { ConnectorElementView } from '@blocksuite/affine/gfx/connector';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import {
  createGroupFromSelectedCommand,
  ungroupCommand,
} from '@blocksuite/affine/gfx/group';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import {
  MindMapDragExtension,
  MindMapView,
  mindmapToolbarConfig,
} from '@blocksuite/affine/gfx/mindmap';
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import { Bound } from '@blocksuite/affine/global/gfx';
import {
  type ConnectorElementModel,
  type GroupElementModel,
  LayoutType,
  type MindmapElementModel,
  MindmapStyle,
  type NoteBlockModel,
} from '@blocksuite/affine/model';
import type { ToolbarContext } from '@blocksuite/affine/shared/services';
import { EditPropsStore } from '@blocksuite/affine/shared/services';
import { boardWrites } from '@blocksuite/affine/shared/utils';
import { BlockStdScope, type PointerEventState } from '@blocksuite/affine/std';
import {
  type DragEndContext,
  type DragMoveContext,
  type DragStartContext,
  GfxControllerIdentifier,
  type GfxModel,
  InteractivityIdentifier,
  InteractivityManager,
  ToolController,
} from '@blocksuite/affine/std/gfx';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
// BlockSuite's slider and element toolbar actions, which their entries don't
// export.
import { createBuiltinToolbarConfigExtension } from '../../../vendor/blocksuite/affine/blocks/note/src/configs/toolbar';
import {
  builtinLockedToolbarConfig,
  builtinMiscToolbarConfig,
} from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/misc';
import { moreActions } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/more';
import { Slider } from '../../../vendor/blocksuite/affine/components/src/slider/slider';
import { collectedSize } from '../collaboration/collectedSize';
import { boardFirstState } from './boardFirstState';
import { gateBoardWrites } from './boardGates';
import { PlaneElementModel } from './boardPlane';
import { openRoomStore } from './roomStore';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const {
  BOARD_WRITE_BYTES,
  bytesOf,
  gateCommands,
  gateElementUpdates,
  gateSelectionWrites,
  gateToolbarWrites,
  anyBytes,
  growthUpdated,
  longestIndex,
  mergeWrites,
  orderWrites,
  setBoardFull,
  setBoardSizer,
  unlockWrites,
  valuesUpdated,
  writesOf,
} = await import('./boardFull');
type Writes = import('./boardFull').Writes;

/* What a full board's write gate counts and where it sits (Epo 2026-11-25),
 * on BlockSuite's own std, interactivity manager, DefaultTool, element CRUD,
 * commands and toolbar actions, as the board mounts them, with real models;
 * no view is rendered. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
  GroupStoreExtension,
  MindmapStoreExtension,
  TextStoreExtension,
  BrushStoreExtension,
]);

const MAX = 4 * 1024 * 1024;

beforeEach(() => {
  vi.mocked(userToast).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A canvas's room opened with BlockSuite's std over it: its elements, the
 * updates it writes, and its size `room` bytes under its cap (`roomFor`),
 * full while `full`. */
function board() {
  // The std's keyboard listens on the document; BlockSuite's geometry
  // measures with DOMRect (the viewport, unshown, an empty one).
  vi.stubGlobal('document', parseHTML('<div></div>').document);
  vi.stubGlobal(
    'DOMRect',
    class {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
      constructor(x = 0, y = 0, width = 0, height = 0) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
      }
      get left() {
        return this.x;
      }
      get top() {
        return this.y;
      }
    }
  );
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
  onTestFinished(dispose);
  const std = new BlockStdScope({
    extensions: [
      InteractivityManager,
      ToolController,
      EdgelessCRUDExtension,
      EditPropsStore,
    ],
    store,
  });
  const gfx = std.get(GfxControllerIdentifier);
  gfx.selection.mounted();
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'room') sent.push(update);
  });
  let bytes = MAX;
  setBoardSizer(store, {
    check: vi.fn(),
    pressed: vi.fn(),
    size: () => ({ bytes, max: MAX }),
  });
  setBoardFull(store, true);
  /** Leaves room for `values` values' stubs and `grows` bytes more. */
  const roomFor = (values: number, grows = 0) => {
    bytes = MAX - BOARD_WRITE_BYTES * values - grows;
  };
  /** Leaves room for what `writes` keeps, less `short` bytes. */
  const roomShort = (writes: Writes, short: number) => {
    bytes = MAX - bytesOf(writes) + short;
  };
  const at = (id: string) => surface.getElementById(id) as GfxModel;
  const shape = (x: number) =>
    surface.addElement({
      shapeType: 'rect',
      type: 'shape',
      xywh: `[${x},0,10,10]`,
    });
  const written = (
    models: GfxModel[],
    gesture: Parameters<typeof writesOf>[1]
  ) => writesOf(models, gesture, (id) => surface.getConnectors(id));
  const longest = () => longestIndex(gfx.gfxElements);
  return {
    at,
    doc,
    gfx,
    longest,
    roomFor,
    roomShort,
    sent,
    shape,
    std,
    store,
    surface,
    written,
  };
}

type Board = ReturnType<typeof board>;

/** A group of `ids`. */
const group = ({ surface }: Board, ids: string[]) =>
  surface.addElement({
    children: Object.fromEntries(ids.map((id) => [id, true])),
    title: new Y.Text('g'),
    type: 'group',
  });

/** A labelled connector from `source` to `target` (ids or free points). */
const connector = (
  { surface }: Board,
  source: string | [number, number],
  target: string | [number, number]
) =>
  surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [0, 0, 20, 10],
    mode: 0,
    source: typeof source === 'string' ? { id: source } : { position: source },
    target: typeof target === 'string' ? { id: target } : { position: target },
    text: new Y.Text('l'),
    type: 'connector',
  });

/** A mind map of shapes: a root at `x` and `children` nodes under it, a
 * level at a time, four to a node. */
function mindmap(b: Board, x: number, children: number) {
  const ids = [b.shape(x)];
  const tree: Record<string, { index: string; parent?: string }> = {
    [ids[0]]: { index: 'a0' },
  };
  for (let n = 1; n <= children; n++) {
    const id = b.shape(x + 30 * n);
    tree[id] = { index: `a${n}`, parent: ids[Math.floor((n - 1) / 4)] };
    ids.push(id);
  }
  const map = b.at(
    b.surface.addElement({ children: tree, type: 'mindmap' })
  ) as MindmapElementModel;
  return { ids, map };
}

/** What the toolbar's change `props` on `models` writes, as the board's
 * gate counts it. */
const updated = (
  models: GfxModel[],
  props: Record<string, unknown>
): Writes => ({
  elements: models.length,
  grows: models.reduce((sum, model) => sum + growthUpdated(model, props), 0),
  values: models.reduce((sum, model) => sum + valuesUpdated(model, props), 0),
});

/** BlockSuite's own drag of the node `moved` of `from` dropped on the root
 * of `into` (`MindMapDragExtension`, the pointer over that root), merging
 * it there. */
function dropOnRoot(
  b: Board,
  from: MindmapElementModel,
  moved: string,
  into: MindmapElementModel
) {
  const target = into.tree.element.elementBound.center;
  const drag = new MindMapDragExtension(b.gfx) as unknown as {
    _calcDragResponseArea: (map: MindmapElementModel) => void;
    _createManipulationHandlers: (ctx: unknown) => {
      onDragEnd: (context: unknown) => void;
      onDragMove: (context: unknown) => void;
    };
    _getHoveredMindMap: () => MindmapElementModel;
  };
  drag._getHoveredMindMap = () => {
    drag._calcDragResponseArea(into);
    return into;
  };
  const { onDragEnd, onDragMove } = drag._createManipulationHandlers({
    isRoot: false,
    mindmap: from,
    node: from.getNode(moved),
    originalMindMapBound: from.elementBound,
  });
  const at = { x: target[0], y: target[1] };
  onDragMove({ dragLastPos: at });
  onDragEnd({ dragLastPos: at, dragStartPos: at });
}

/** The connector watcher works a microtask after a change. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

// Review of 8d813a7cc, findings 1, 2 and 5: what a gesture writes is every
// element it reaches, each with every value it writes there. Fourth review:
// and what each value may grow by, a box to 105 characters (`[0,0,10,10]`
// by 94), a whole number to a float64 (by 7). Fails if a group counts as
// one, a mind map's node as one, a connector, a text label's resize, a
// stroke's resize or a rotation as one value each, or a growth is left out.
it("counts a group's elements, a mind map's nodes, each value written and the labels hanging on them", async () => {
  const b = board();
  const [a1, a2, x] = [b.shape(0), b.shape(20), b.shape(40)];
  const g = group(b, [a1, a2]);
  const hanging = connector(b, a1, x);
  const root = b.shape(0);
  const node = b.shape(30);
  b.surface.addElement({
    children: {
      [node]: { index: 'a0', parent: root },
      [root]: { index: 'a0' },
    },
    type: 'mindmap',
  });
  const text = b.surface.addElement({
    text: new Y.Text('t'),
    type: 'text',
    xywh: '[0,40,20,10]',
  });
  const stroke = b.surface.addElement({
    points: [
      [0, 0],
      [10, 10],
    ],
    type: 'brush',
  });
  await settled();
  // The group (nothing of its own), its two shapes (their boxes 94 and 93),
  // and the label of the connector hanging on one of them (four whole
  // numbers, 7 each).
  expect(b.written([b.at(g)], 'move')).toEqual({
    elements: 4,
    grows: 94 + 93 + 4 * 7,
    values: 3,
  });
  // A node dragged alone may restyle its whole map: the map's tree and both
  // nodes at the Style count (9 a node), their boxes, and the node's place in
  // the tree (an index one character longer).
  expect(b.written([b.at(node)], 'move')).toEqual({
    elements: 3,
    grows: 94 + 93 + 1,
    values: 19,
  });
  // A connector moved with its ends: its free ends and label, at most (its
  // ends bound, so its label's growth alone).
  expect(b.written([b.at(hanging), b.at(a1), b.at(x)], 'move')).toEqual({
    elements: 3,
    grows: 94 + 93 + 4 * 7,
    values: 5,
  });
  // A text label's resize writes its box and font size, a stroke's its box
  // and points (as long as they were); the shape's box moves the label
  // hanging on it.
  expect(b.written([b.at(text), b.at(stroke), b.at(x)], 'resize')).toEqual({
    elements: 4,
    grows: 93 + 7 + 92 + 93 + 4 * 7,
    values: 6,
  });
  // A rotation writes an angle and a place.
  expect(b.written([b.at(text), b.at(stroke)], 'rotate')).toEqual({
    elements: 2,
    grows: 93 + 7 + 92 + 7,
    values: 4,
  });
});

// Second review of the guard, findings 4 and 6: a mind map's Style restyles
// every node and its Layout moves each one; a note showing a size it
// measured stores it before a gesture's own write (local change 75); a
// labelled connector's mode, changed through the toolbar, places its label
// again. Third review: a node dragged alone may restyle its map. Fails if a
// node counts one value, a note one, a mode change leaves out the label, or
// a node's drag counts its map's boxes alone.
it("counts a mind map's Style and Layout per node, a node's drag as its map's Style, a note's shown size, and a connector's label at a mode change", async () => {
  const b = board();
  const { ids, map } = mindmap(b, 0, 3);
  const root = b.store.root;
  if (!root) throw new Error('no root');
  const note = b.store.getModelById(
    b.store.addBlock('affine:note', { xywh: '[0,300,200,80]' }, root)
  ) as NoteBlockModel;
  const labelled = connector(b, [0, 100], [50, 150]);
  const bare = b.surface.addElement({
    mode: 0,
    source: { position: [0, 200] },
    target: { position: [50, 250] },
    type: 'connector',
  });
  await settled();
  // The map's value and 9 a node (measured below), each node's box at its
  // longest (`[0,0,10,10]` by 94, the others by 93).
  const boxes = 94 + 3 * 93;
  expect(b.written([map], 'style')).toEqual({
    elements: 5,
    grows: boxes,
    values: 37,
  });
  expect(b.written([map], 'layout')).toEqual({
    elements: 5,
    grows: boxes,
    values: 9,
  });
  // A node dragged alone: its whole map at its Style count and its place in
  // the tree; its root moves the map.
  expect(b.written([b.at(ids[1])], 'move')).toEqual({
    elements: 5,
    grows: boxes + 1,
    values: 37,
  });
  expect(b.written([b.at(ids[0])], 'move')).toEqual({
    elements: 5,
    grows: boxes,
    values: 5,
  });
  expect(b.written([note, b.at(b.shape(500))], 'move')).toEqual({
    elements: 2,
    grows: 91 + 92,
    values: 3,
  });
  expect(valuesUpdated(b.at(labelled), { mode: 1 })).toBe(2);
  expect(valuesUpdated(b.at(bare), { mode: 1 })).toBe(1);
  expect(valuesUpdated(b.at(labelled), { stroke: 'red' })).toBe(1);
  // A mode change places the label again, its four numbers at their
  // longest (an array's two bytes, then 9 each); a colour turned themed
  // grows by its object less its string.
  expect(growthUpdated(b.at(labelled), { mode: 1 })).toBe(
    2 +
      4 * 9 -
      anyBytes((b.at(labelled) as ConnectorElementModel).yMap.get('labelXYWH'))
  );
  expect(growthUpdated(b.at(bare), { mode: 1 })).toBe(0);
  expect(
    growthUpdated(b.at(bare), {
      stroke: { dark: '#000000', light: '#ffffff' },
    })
  ).toBe(
    1 +
      1 +
      (1 + 4 + 1 + 1 + 7) +
      (1 + 5 + 1 + 1 + 7) -
      anyBytes((b.at(bare) as ConnectorElementModel).yMap.get('stroke'))
  );
});

// Second, third and fourth reviews of the guard: what the gate counts for
// each gesture bounds what it adds to the room's collected state
// (`collectedSize`, what the room measures), on a board whose clocks passed
// 10^5: each overwritten value's stub carries its clock twice, 3 bytes each
// there (a fresh board's are 1 or 2), a value written for the first time
// adds its key, and a value written longer than it was the difference (a box
// placed on whole numbers dragged at zoom 0.73, a whole angle turned to a
// float, a colour turned themed). Each gesture writes as BlockSuite's does:
// the board's `updateElement` and `updateBlock` in one change, a connector's
// drag through its view, a resize by its handlers' stashes, the toolbar's
// reorder and Unlock through their actions, an ungroup through its command,
// a mind map's Style and Layout on its own layout (the view's) over every
// change of style and layout of a 21-node map, and a node dropped on another
// map through its drag. Fails if one grows the board past what its count
// keeps (`bytesOf`).
it('grows a board whose clocks passed 10^5 by no more than the gate counts for each gesture', async () => {
  const b = board();
  const aged = b.doc.getText('aged');
  aged.insert(0, 'x'.repeat(200_000));
  aged.delete(0, 200_000);
  const n = 20;
  const each = (make: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => make(i));
  const shapes = each((i) => b.shape(20 * i));
  const texts = each((i) =>
    b.surface.addElement({
      text: new Y.Text('t'),
      type: 'text',
      xywh: `[${20 * i},100,20,10]`,
    })
  );
  const strokes = each((i) =>
    b.surface.addElement({
      lineWidth: 4,
      points: [
        [i, 300],
        [i + 10, 310],
      ],
      type: 'brush',
    })
  );
  const connectors = each((i) =>
    connector(b, [20 * i, 200], [20 * i + 10, 250])
  );
  const root = b.store.root;
  if (!root) throw new Error('no root');
  const notes = each((i) =>
    b.store.addBlock('affine:note', { xywh: `[${300 * i},500,200,80]` }, root)
  ).map((id) => b.store.getModelById(id) as NoteBlockModel);
  const { map } = mindmap(b, 0, 20);
  (
    MindMapView.prototype as unknown as { _setLayoutMethod: () => void }
  )._setLayoutMethod.call({ model: map });
  // Its nodes fit their text, measured through the DOM (here every line 20
  // px high).
  const measured = () => ({
    append: () => {},
    getBoundingClientRect: () => ({ height: 20 }),
    innerText: '',
    remove: () => {},
    style: {},
  });
  vi.stubGlobal('document', { body: measured(), createElement: measured });
  map.layout();
  await settled();
  const fits = async (counted: Writes, change: () => void, label: string) => {
    const before = collectedSize(b.doc);
    b.store.transact(change);
    await settled();
    const grew = collectedSize(b.doc) - before;
    expect(grew, label).toBeLessThanOrEqual(bytesOf(counted));
  };
  /** At zoom 0.73 a drag or resize writes 17 significant digits
   * (`Bound.serialize`). */
  const zoomed = (bound: Bound, dx: number, dy: number) =>
    new Bound(bound.x + dx / 0.73, bound.y + dy / 0.73, bound.w, bound.h);
  const models = (ids: string[]) => ids.map(b.at);
  const crud = b.std.get(EdgelessCRUDIdentifier);
  await fits(
    b.written(models(shapes), 'move'),
    () => {
      for (const [i, id] of shapes.entries())
        crud.updateElement(id, { xywh: `[${20 * i},5,10,10]` });
    },
    'a move'
  );
  await fits(
    b.written(models(shapes), 'move'),
    () => {
      for (const model of models(shapes))
        crud.updateElement(model.id, {
          xywh: zoomed(Bound.deserialize(model.xywh), 37, 11).serialize(),
        });
    },
    'a move from whole numbers to floats at zoom 0.73'
  );
  await fits(
    b.written(models(shapes), 'rotate'),
    () => {
      for (const [i, id] of shapes.entries())
        crud.updateElement(id, { rotate: 30, xywh: `[${20 * i},8,10,10]` });
    },
    'a rotation'
  );
  await fits(
    b.written(models(shapes), 'rotate'),
    () => {
      for (const model of models(shapes))
        crud.updateElement(model.id, {
          rotate: 30 / 0.73,
          xywh: zoomed(Bound.deserialize(model.xywh), 5, 0).serialize(),
        });
    },
    'a rotation from a whole angle to a float'
  );
  await fits(
    b.written(models(texts), 'resize'),
    () => {
      for (const [i, id] of texts.entries())
        crud.updateElement(id, { fontSize: 30, xywh: `[${20 * i},100,40,20]` });
    },
    "a text label's resize"
  );
  await fits(
    updated(models(strokes), { lineWidth: 8 }),
    () => {
      for (const id of strokes) crud.updateElement(id, { lineWidth: 8 });
    },
    "a stroke's width"
  );
  await fits(
    b.written(models(strokes), 'resize'),
    () => {
      for (const model of models(strokes)) {
        const { x, y, w, h } = Bound.deserialize(model.xywh);
        crud.updateElement(model.id, {
          xywh: new Bound(x, y, w / 0.73, h / 0.73).serialize(),
        });
      }
    },
    "a stroke's resize"
  );
  await fits(
    updated(models(shapes), { fillColor: '#ff0000' }),
    () => {
      for (const id of shapes) crud.updateElement(id, { fillColor: '#ff0000' });
    },
    'a fill'
  );
  const themed = { dark: '#252525', light: '#ffffff' };
  await fits(
    updated(models(shapes), { fillColor: themed }),
    () => {
      for (const id of shapes) crud.updateElement(id, { fillColor: themed });
    },
    'a fill from a colour to a themed one'
  );
  await fits(
    b.written(models(connectors), 'move'),
    () => {
      for (const model of models(connectors)) {
        const view = new ConnectorElementView(
          model as ConnectorElementModel,
          b.gfx
        );
        view.onDragStart({} as DragStartContext);
        view.onDragMove({
          currentBound: model.elementBound,
          dx: 0,
          dy: 40,
        } as DragMoveContext);
        view.onDragEnd({} as DragEndContext);
      }
    },
    "a connector's drag"
  );
  await fits(
    updated(models(connectors), { mode: 1 }),
    () => {
      for (const id of connectors) crud.updateElement(id, { mode: 1 });
    },
    "a connector's mode"
  );
  // A note placed and scaled for the first time adds its collapse, its
  // collapsed height and its scale.
  await fits(
    b.written(notes, 'place'),
    () => {
      for (const [i, note] of notes.entries()) {
        b.store.updateBlock(note, () => {
          note.props.edgeless.collapse = true;
          note.props.edgeless.collapsedHeight = 90;
        });
        crud.updateElement(note.id, { xywh: `[${300 * i},600,200,90]` });
      }
    },
    "a note's place"
  );
  await fits(
    b.written(notes, 'scale'),
    () => {
      for (const [i, note] of notes.entries())
        b.store.updateBlock(note, () => {
          note.xywh = `[${300 * i},600,400,180]`;
          note.props.edgeless.scale = 2;
        });
    },
    "a note's Scale"
  );
  await fits(
    b.written(notes, 'resize'),
    () => {
      // A corner, as the note's resize handlers write it.
      for (const note of notes) {
        const { x, y, w, h } = Bound.deserialize(note.xywh);
        note.stash('xywh');
        note.stash('edgeless');
        note.props.edgeless = { ...note.props.edgeless, scale: 2 / 0.73 };
        note.props.xywh = new Bound(x, y, w / 0.73, h / 0.73).serialize();
        note.pop('xywh');
        note.pop('edgeless');
      }
    },
    "a note's resize"
  );
  await fits(
    b.written(notes, 'height'),
    () => {
      // Its Customized height, as the toolbar writes it.
      for (const note of notes)
        b.store.updateBlock(note, () => {
          const bound = Bound.deserialize(note.xywh);
          bound.h = 90 * (note.props.edgeless.scale ?? 1);
          note.xywh = bound.serialize();
          note.props.edgeless.collapse = true;
        });
    },
    "a note's height"
  );
  const panel = notes.map((note) => ({
    edgeless: {
      ...note.props.edgeless,
      style: { ...note.props.edgeless.style, borderRadius: 8 },
    },
  }));
  await fits(
    notes
      .map((note, i) => updated([note], panel[i]))
      .reduce((sum, each) => ({
        elements: sum.elements + each.elements,
        grows: sum.grows + each.grows,
        values: sum.values + each.values,
      })),
    () => {
      for (const [i, note] of notes.entries())
        crud.updateElement(note.id, panel[i]);
    },
    "a note's corners through its style panel"
  );
  await fits(
    orderWrites(models(shapes), b.longest()),
    () =>
      action(moreActions, 'a.bring-to-front').run(toolbar(b, models(shapes))),
    'a reorder'
  );
  const locked = [
    b.at(
      group(
        b,
        each((i) => b.shape(20 * i))
      )
    ),
    ...models(strokes),
  ];
  for (const model of locked) model.lock();
  await fits(
    unlockWrites(locked, b.longest()),
    () =>
      action(builtinLockedToolbarConfig.actions, 'b.unlock').run(
        toolbar(b, locked)
      ),
    'an Unlock'
  );
  const grouped = b.at(group(b, texts)) as GroupElementModel;
  await fits(
    orderWrites(grouped.childElements, b.longest()),
    () => b.std.command.exec(ungroupCommand, { group: grouped as never }),
    'an ungroup'
  );
  const planes = models(
    each((i) =>
      b.surface.addElement({
        type: 'plane',
        x0: -1,
        xywh: `[${200 * i},900,160,120]`,
        y0: 1,
      })
    )
  ) as PlaneElementModel[];
  expect(planes.every((plane) => plane instanceof PlaneElementModel)).toBe(
    true
  );
  await fits(
    b.written(planes, 'resize'),
    () => {
      // As its resize handlers write it: its view follows the dragged side.
      for (const plane of planes) {
        const { x, y, w, h } = Bound.deserialize(plane.xywh);
        plane.fit = false;
        for (const key of ['xywh', 'x0', 'y0']) plane.stash(key);
        plane.xywh = new Bound(x + 7 / 0.73, y, w - 7 / 0.73, h).serialize();
        plane.x0 = -1 + 7 / 0.73 / plane.ppu;
        plane.y0 = 1 - 3 / 0.73 / plane.ppu;
        for (const key of ['xywh', 'x0', 'y0']) plane.pop(key);
      }
    },
    "a plane's resize"
  );
  const node = b.at(map.tree.children[0].id) as unknown as {
    strokeColor: unknown;
  };
  const colour = node.strokeColor;
  let restyled = false;
  for (const style of [
    MindmapStyle.TWO,
    MindmapStyle.THREE,
    MindmapStyle.FOUR,
    MindmapStyle.ONE,
    MindmapStyle.THREE,
    MindmapStyle.TWO,
    MindmapStyle.FOUR,
    MindmapStyle.ONE,
  ]) {
    await fits(
      b.written([map], 'style'),
      () => {
        map.style = style;
      },
      `Style ${style}`
    );
    restyled ||= node.strokeColor !== colour;
  }
  expect(restyled).toBe(true);
  for (const layout of [
    LayoutType.LEFT,
    LayoutType.BALANCE,
    LayoutType.RIGHT,
    LayoutType.BALANCE,
  ])
    await fits(
      b.written([map], 'layout'),
      () => {
        map.layoutType = layout;
        map.layout();
      },
      `Layout ${layout}`
    );
  // A node of one map dropped on another's root, both laid out.
  const from = mindmap(b, 2000, 4);
  const into = mindmap(b, 3000, 4);
  for (const laid of [from.map, into.map]) {
    (
      MindMapView.prototype as unknown as { _setLayoutMethod: () => void }
    )._setLayoutMethod.call({ model: laid });
    laid.layout();
  }
  await settled();
  const branch = from.map.getNode(from.ids[1]);
  if (!branch) throw new Error('no node');
  const moving = [
    branch.element,
    ...branch.children.map((child) => child.element),
  ];
  await fits(
    mergeWrites(into.map, moving, b.written),
    () => dropOnRoot(b, from.map, from.ids[1], into.map),
    'a merge'
  );
  expect(into.map.getNode(from.ids[1])).not.toBeNull();
});

// Review of 8d813a7cc, tests: the gate sits on the board's one
// InteractivityManager, the one BlockSuite's DefaultTool and its selection
// frame (`edgeless-selected-rect.ts`'s `_interaction`) get from the std.
// Fails if a drag DefaultTool starts, or a resize or rotation the frame
// starts, reaches BlockSuite's own handler past a full board's cap.
it("gates the drag DefaultTool starts and the frame's resize and rotation on the std's InteractivityManager", async () => {
  const b = board();
  const [a1, a2] = [b.shape(0), b.shape(20)];
  const g = group(b, [a1, a2]);
  const interactivity = b.std.get(InteractivityIdentifier);
  const started = {
    handleElementMove: vi.fn(),
    handleElementResize: vi.fn(),
    handleElementRotate: vi.fn(),
  };
  Object.assign(interactivity, started);
  gateSelectionWrites(b.store, interactivity, b.written);

  // A drag of the selected group from inside it: the group's two shapes.
  b.gfx.selection.set({ editing: false, elements: [g] });
  const [x, y] = b.gfx.viewport.toViewCoord(5, 5);
  b.gfx.tool.lastMouseViewPos$.value = { x, y };
  const drag = () =>
    new DefaultTool(b.gfx).dragStart({
      button: 0,
      keys: { alt: false },
      raw: {},
    } as unknown as PointerEventState);
  // Two boxes, and what they may grow by.
  const moved = b.written([b.at(g)], 'move');
  expect(moved).toEqual({ elements: 3, grows: 94 + 93, values: 2 });
  b.roomShort(moved, 1);
  await drag();
  expect(started.handleElementMove).not.toHaveBeenCalled();
  expect(userToast).toHaveBeenCalledOnce();
  b.roomShort(moved, 0);
  await drag();
  expect(started.handleElementMove).toHaveBeenCalledOnce();

  // What the selection frame calls at a press on its handles: a rotation
  // writes an angle too.
  const frame = b.std.getOptional(InteractivityIdentifier);
  const elements = [b.at(a1), b.at(a2)];
  const turned = b.written(elements, 'rotate');
  expect(turned).toEqual({ elements: 2, grows: 94 + 93 + 2 * 7, values: 4 });
  b.roomShort(turned, 1);
  frame?.handleElementRotate({ elements } as never);
  expect(started.handleElementRotate).not.toHaveBeenCalled();
  frame?.handleElementResize({ elements } as never);
  expect(started.handleElementResize).toHaveBeenCalledOnce();
  b.roomShort(turned, 0);
  frame?.handleElementRotate({ elements } as never);
  expect(started.handleElementRotate).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledTimes(2);
});

// Review of 8d813a7cc, finding 5: the element toolbar writes through the
// std's element CRUD, every value it names on every selected element.
// Fails if a change naming several values counts one an element, or if a
// refused change writes any element.
it("refuses a toolbar change through the std's CRUD whole, counting every value it names", () => {
  const b = board();
  const ids = [b.shape(0), b.shape(20), b.shape(40)];
  b.gfx.selection.set({ editing: false, elements: ids });
  const crud = b.std.get(EdgelessCRUDIdentifier);
  gateElementUpdates(b.store, crud, (id) =>
    ids.includes(id) ? ids.map(b.at) : null
  );
  b.sent.length = 0;
  b.roomFor(5);
  // What the toolbar's actions call (`ctx.std.get(EdgelessCRUDIdentifier)`).
  for (const id of ids)
    b.std
      .get(EdgelessCRUDIdentifier)
      .updateElement(id, { fillColor: 'red', strokeColor: 'blue' });
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
});

// Review of 8d813a7cc, finding 9: an Unlock of a locked group ungroups it,
// which writes the index of each element the group holds directly. Fails
// if the gate counts what nested groups hold, refusing an unlock there is
// room for, or lets a refused ungroup write.
it('ungroups a group when its direct elements fit, however many its groups hold, and refuses one that does not', () => {
  const b = board();
  const inner = group(b, [b.shape(0), b.shape(20), b.shape(40)]);
  const outer = group(b, [inner, b.shape(60)]);
  gateCommands(
    b.store,
    b.std.command,
    { adds: [], places: [], ungroup: ungroupCommand },
    () => ({ elements: 0, grows: 0, values: 0 }),
    b.longest
  );
  // Its two direct elements' indexes, made next to the board's (two
  // characters long): the first at most 3 long, the second 4.
  const ungrouped = orderWrites(
    (b.at(outer) as GroupElementModel).childElements,
    b.longest()
  );
  expect(ungrouped).toEqual({ elements: 2, grows: 3 + 4 - 2 - 2, values: 2 });
  b.roomShort(ungrouped, 1);
  b.sent.length = 0;
  const [refused] = b.std.command.exec(ungroupCommand, {
    group: b.at(outer) as never,
  });
  expect(refused).toBe(false);
  expect(b.sent).toEqual([]);
  b.roomShort(ungrouped, 0);
  const [done] = b.std.command.exec(ungroupCommand, {
    group: b.at(outer) as never,
  });
  expect(done).toBe(true);
  expect(b.surface.hasElementById(outer)).toBe(false);
  expect(b.at(inner).group).toBeNull();
});

/** The element toolbar's context for the selected `models`. */
const toolbar = (b: Board, models: GfxModel[]) =>
  ({
    command: b.std.command,
    getSurfaceModels: () => models,
    getSurfaceModelsByType: (
      type: abstract new (...args: never[]) => unknown
    ) => models.filter((model) => model instanceof type),
    gfx: b.gfx,
    matchModel: (
      model: unknown,
      type: abstract new (...args: never[]) => unknown
    ) => model instanceof type,
    settings: { recordLastProps: vi.fn() },
    std: b.std,
    store: b.store,
    track: vi.fn(),
  }) as unknown as ToolbarContext;

/** A toolbar action by its id, in a list that nests groups of them. */
function action(
  actions: readonly unknown[],
  id: string
): { run: (ctx: ToolbarContext) => void } {
  const all = (
    list: readonly unknown[]
  ): { actions?: unknown[]; id: string }[] =>
    (list as { actions?: unknown[]; id: string }[]).flatMap((each) => [
      each,
      ...all(each.actions ?? []),
    ]);
  const found = all(actions).find((each) => each.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found as never;
}

// Review of 8d813a7cc, finding 7 (vendor/blocksuite local change 82): a
// lock of several groups them, after moving them between groups, and a
// reorder writes each index; on a full board each asks before writing any.
// Fails if a refused lock or reorder writes anything.
it('refuses a lock of several and a reorder past a full board before either writes', () => {
  const b = board();
  const [a1, a2, x] = [b.shape(0), b.shape(20), b.shape(40)];
  group(b, [a1, a2]);
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  b.roomFor(10);
  b.sent.length = 0;
  const models = [b.at(a1), b.at(x)];
  action(builtinMiscToolbarConfig.actions, 'b.lock').run(toolbar(b, models));
  expect(b.sent).toEqual([]);
  expect(b.at(a1).group).not.toBeNull();
  // Two indexes made next to the board's (two characters long): the first
  // at most 3 long, the second 4.
  const reordered = orderWrites(models, b.longest());
  expect(reordered).toEqual({ elements: 2, grows: 3 + 4 - 2 - 2, values: 2 });
  b.roomShort(reordered, 1);
  action(moreActions, 'a.bring-to-front').run(toolbar(b, models));
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledTimes(2);
  b.roomShort(reordered, 0);
  action(moreActions, 'a.bring-to-front').run(toolbar(b, models));
  expect(b.sent).not.toEqual([]);
});

/** The handlers a lit template sets for `event` (`@click`, `@select`), in
 * order, through what its repeats render for each item: what a press there
 * runs, with no view rendered. */
function handlers(template: unknown, event: string): ((e?: Event) => void)[] {
  const { strings, values } = (template ?? {}) as {
    strings?: readonly string[];
    values?: unknown[];
  };
  if (!values) return [];
  if (!strings) {
    // lit's `repeat(items, key, render)`.
    const [items, , render] = values as [
      unknown[],
      unknown,
      (item: unknown) => unknown,
    ];
    return typeof render === 'function'
      ? items.flatMap((item) => handlers(render(item), event))
      : [];
  }
  return values.flatMap((value, at) =>
    strings[at].trimEnd().endsWith(`${event}=`)
      ? [value as (e?: Event) => void]
      : (Array.isArray(value) ? value : [value]).flatMap((each) =>
          handlers(each, event)
        )
  );
}

type Content = { content: (ctx: ToolbarContext) => unknown };

// Review of 8d813a7cc, finding 7 (local change 82): the alignment menu's pick
// moves a connector (`moveTo`) before the board's `updateElement` sees the
// first element. Fails if a refused Align left writes anything.
it("refuses the alignment menu's pick past a full board before any element moves, a connector first", () => {
  const b = board();
  const loose = connector(b, [0, 100], [50, 150]);
  const models = [b.at(loose), b.at(b.shape(20)), b.at(b.shape(40))];
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  const align = () => {
    const menu = (
      action(
        builtinMiscToolbarConfig.actions,
        'd.alignment'
      ) as unknown as Content
    ).content(toolbar(b, models));
    // Its first item is Align left.
    handlers(menu, '@click')[0]();
  };
  // The connector's free ends and label, and the two shapes' boxes, with
  // what each may grow by.
  const placed = b.written(models, 'place');
  expect(placed).toMatchObject({ elements: 3, values: 5 });
  b.roomShort(placed, 1);
  b.sent.length = 0;
  align();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  b.roomShort(placed, 0);
  align();
  expect(b.sent).not.toEqual([]);
});

// Leftovers of 0366a0a15, item 2 (local change 82): a note's Scale writes
// each note's box and scale straight to the block; second review: its Auto or
// Customized height its box and collapse. Each note stores a size it shows
// first (local change 75). Fails if a refused Scale or height writes any note.
it("refuses a note's Scale and height of several notes past a full board before any note changes", () => {
  const b = board();
  const root = b.store.root;
  if (!root) throw new Error('no root');
  const notes = [0, 300].map(
    (x) =>
      b.store.getModelById(
        b.store.addBlock('affine:note', { xywh: `[${x},0,200,80]` }, root)
      ) as NoteBlockModel
  );
  for (const note of notes)
    b.store.updateBlock(note, () => {
      note.props.edgeless.collapse = true;
    });
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  let module: { config: { actions: unknown[] } } | undefined;
  for (const extension of createBuiltinToolbarConfigExtension('affine:note'))
    extension.setup({
      addImpl: (_: unknown, impl: typeof module) => {
        module = impl;
      },
    } as never);
  const actions = module?.config.actions ?? [];
  const scale = (percent: number) => {
    const menu = (action(actions, 'g.scale') as unknown as Content).content(
      toolbar(b, notes)
    );
    handlers(menu, '@select')[0](
      new CustomEvent('select', { detail: percent })
    );
  };
  const height = () => {
    const ctx = toolbar(b, notes);
    (
      action(actions, 'f.auto-height') as unknown as {
        generate: (ctx: ToolbarContext) => {
          run: (ctx: ToolbarContext) => void;
        };
      }
    )
      .generate(ctx)
      .run(ctx);
  };
  // Two notes: a Scale four values each (its scale a new key) and its box
  // and scale at their longest (`[0,0,200,80]` by 93, `[300,0,200,80]` by
  // 91, a scale from none by 9), a height three and its box.
  const scaled = b.written(notes, 'scale');
  expect(scaled).toEqual({ elements: 2, grows: 93 + 91 + 2 * 9, values: 8 });
  const sized = b.written(notes, 'height');
  expect(sized).toEqual({ elements: 2, grows: 93 + 91, values: 6 });
  b.roomShort(scaled, 1);
  b.sent.length = 0;
  scale(200);
  b.roomShort(sized, 1);
  height();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledTimes(2);
  b.roomShort(scaled, 0);
  scale(200);
  b.roomShort(sized, 0);
  height();
  expect(notes.map((note) => note.props.edgeless.scale)).toEqual([2, 2]);
  expect(notes.map((note) => note.props.edgeless.collapse)).toEqual([
    false,
    false,
  ]);
});

// Leftovers of 0366a0a15, item 2 (local change 84): the width slider picked
// again at every pointer move, the value unchanged too, and each pick
// rewrites every selected element's width. Second review: a press on the
// shown width (the most common of mixed widths) must still pick it. Fails if
// a move that keeps the value picks, or a press does not.
it('picks a width at the press and as a drag changes it, not at every move', () => {
  const slider = new Slider();
  Object.assign(slider, { range: { points: [2, 4, 6, 8] }, value: 4 });
  // 100 px wide, unrendered.
  slider.getBoundingClientRect = () => ({ width: 100 }) as DOMRect;
  const picked: number[] = [];
  slider.addEventListener('select', (event) =>
    picked.push((event as CustomEvent<{ value: number }>).detail.value)
  );
  const at = (type: string, offsetX: number) =>
    Object.assign(new Event(type), { offsetX }) as PointerEvent;
  const press = (offsetX: number) =>
    (
      slider as unknown as { _onPointerDown: (e: PointerEvent) => void }
    )._onPointerDown(at('pointerdown', offsetX));
  // Widths 4, 4 and 8 selected: 4 shows, and a press on it makes all three 4.
  press(40);
  for (const x of [41, 42, 90, 91, 92, 40])
    slider.dispatchEvent(at('pointermove', x));
  slider.dispatchEvent(new Event('pointerup'));
  press(40);
  expect(picked).toEqual([4, 8, 4, 4]);
});

// Leftovers of 0366a0a15, item 3 (local change 82): a mind map's node
// dragged off its map makes a new map. Fails if a full board makes it, or
// writes anything, and if a board with room does not.
it("refuses a mind map's node dragged off its map on a full board, an add, and writes nothing", () => {
  const b = board();
  const root = b.shape(0);
  const node = b.shape(30);
  const map = b.surface.addElement({
    children: {
      [node]: { index: 'a0', parent: root },
      [root]: { index: 'a0' },
    },
    type: 'mindmap',
  });
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  const mindmap = b.at(map) as MindmapElementModel;
  const dragOff = () => {
    const drag = new MindMapDragExtension(b.gfx) as unknown as {
      _createManipulationHandlers: (ctx: unknown) => {
        onDragEnd: (context: unknown) => void;
        onDragMove: (context: unknown) => void;
      };
    };
    const { onDragEnd, onDragMove } = drag._createManipulationHandlers({
      isRoot: false,
      mindmap,
      node: mindmap.getNode(node),
      originalMindMapBound: mindmap.elementBound,
    });
    const far = { x: 5000, y: 5000 };
    onDragMove({ dragLastPos: far });
    onDragEnd({ dragLastPos: far, dragStartPos: { x: 35, y: 5 } });
  };
  b.sent.length = 0;
  dragOff();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  expect(b.surface.getElementsByType('mindmap')).toEqual([mindmap]);
  setBoardFull(b.store, false);
  dragOff();
  expect(b.surface.getElementsByType('mindmap')).toHaveLength(2);
});

// Second review of the guard, finding 4 (local change 82): a mind map's Style
// and Layout menus wrote every node straight to its model. Fails if a refused
// one writes anything, or one with room does not.
it("refuses a mind map's Style and Layout past a full board before any node changes", () => {
  const b = board();
  const { map } = mindmap(b, 0, 2);
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  // The menus' items, in order: Style's one, four, three, two; Layout's
  // left, radial, right.
  const pick = (id: string, item: number) =>
    handlers(
      (action(mindmapToolbarConfig.actions, id) as unknown as Content).content(
        toolbar(b, [map])
      ),
      '@click'
    )[item]();
  // The map's value, and 9 or 2 for each of its three nodes, with their
  // boxes at their longest.
  const styled = b.written([map], 'style');
  expect(styled).toEqual({ elements: 4, grows: 94 + 93 + 93, values: 28 });
  const laidOut = b.written([map], 'layout');
  expect(laidOut).toEqual({ elements: 4, grows: 94 + 93 + 93, values: 7 });
  b.roomShort(styled, 1);
  b.sent.length = 0;
  pick('a.style', 3);
  b.roomShort(laidOut, 1);
  pick('b.layout', 0);
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledTimes(2);
  b.roomShort(styled, 0);
  pick('a.style', 3);
  expect(map.style).toBe(MindmapStyle.TWO);
  b.roomShort(laidOut, 0);
  pick('b.layout', 0);
  expect(map.layoutType).toBe(LayoutType.LEFT);
});

// Second review of the guard, finding 6 (local change 82): an Unlock of
// several writes each element's lock, and ungroups a locked group, writing
// each of its elements. Fails if a refused Unlock writes anything.
it('refuses an Unlock of several past a full board before any element unlocks', () => {
  const b = board();
  const g = group(b, [b.shape(0), b.shape(20), b.shape(40)]);
  const models = [b.at(g), b.at(b.shape(60)), b.at(b.shape(80))];
  for (const model of models) model.lock();
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  const unlock = () =>
    action(builtinLockedToolbarConfig.actions, 'b.unlock').run(
      toolbar(b, models)
    );
  // The group's three elements' indexes, made next to the board's (two
  // characters long, the i-th at most 2 + i), and two locks (as long either
  // way).
  const unlocked = unlockWrites(models, b.longest());
  expect(unlocked).toEqual({
    elements: 5,
    grows: 3 + 4 + 5 - 3 * 2,
    values: 5,
  });
  b.roomShort(unlocked, 1);
  b.sent.length = 0;
  unlock();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  b.roomShort(unlocked, 0);
  unlock();
  expect(models.slice(1).map((model) => model.isLocked())).toEqual([
    false,
    false,
  ]);
  expect(b.surface.hasElementById(g)).toBe(false);
});

// Second review of the guard, finding 6 (local change 82): a node dragged into
// another mind map takes that map's style and lays it out again, a map the
// drag's own count leaves out. Third review: both maps are counted together,
// once. Fails if a refused merge writes anything, or one with room does not
// merge.
it('refuses a node merged into another mind map past a full board, and writes nothing', () => {
  const b = board();
  const from = mindmap(b, 0, 1);
  const into = mindmap(b, 0, 1);
  // The second map sits below the first.
  for (const id of into.ids)
    b.surface.updateElement(id, {
      xywh: b.at(id).elementBound.moveDelta(0, 500).serialize(),
    });
  const stop = gateToolbarWrites(b.store, b.written, b.longest);
  onTestFinished(stop);
  const [, moved] = from.ids;
  const drop = () => dropOnRoot(b, from.map, moved, into.map);
  // Checked once, at the drop, for both maps: the first at its Style count
  // (its value, 9 for each of its two nodes), the second laid out (its value,
  // 2 for each of its two nodes), each node's box at its longest, and the
  // moved node's place in the second map's tree, a new key (its id of 10
  // characters, 11 bytes, and its place at the longest, 32).
  expect(moved).toHaveLength(10);
  const merged = mergeWrites(into.map, [b.at(moved)], b.written);
  expect(merged).toEqual({
    elements: 6,
    grows: 94 + 93 + 92 + 91 + 11 + 32,
    values: 19 + 5 + 2,
  });
  b.roomShort(merged, 1);
  b.sent.length = 0;
  drop();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  expect(from.map.getNode(moved)).not.toBeNull();
  b.roomShort(merged, 0);
  drop();
  expect(into.map.getNode(moved)).not.toBeNull();
});

// Second review of the guard, tests: the board's own wiring
// (`gateBoardWrites`, as `drawingBoard.ts` mounts it) hands each gate what
// the selection writes. Fails if an arrow key, the toolbar's update of a
// group's element or a labelled connector's mode, a group, an arrange of
// notes or a mind map's Style reaches the board past its cap.
it("gates the board's arrow keys, toolbar updates, commands and toolbar writes as the board wires them", async () => {
  const b = board();
  const page = new EventTarget();
  onTestFinished(gateBoardWrites(page, b.std));
  const [a1, a2] = [b.shape(0), b.shape(20)];
  const g = group(b, [a1, a2]);
  const labelled = [
    connector(b, [0, 100], [50, 150]),
    connector(b, [0, 200], [50, 250]),
  ];
  const { map } = mindmap(b, 600, 2);
  await settled();
  const nudge = () => {
    const key = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'ArrowLeft',
    });
    page.dispatchEvent(key);
    return key.defaultPrevented;
  };
  // An arrow key on the group: its two shapes.
  b.gfx.selection.set({ editing: false, elements: [g] });
  const nudged = b.written([b.at(g)], 'move');
  b.roomShort(nudged, 1);
  expect(nudge()).toBe(true);
  b.roomShort(nudged, 0);
  expect(nudge()).toBe(false);
  // The toolbar's fill on the group's elements: the group and its shapes.
  const crud = b.std.get(EdgelessCRUDIdentifier);
  const filled = updated([g, a1, a2].map(b.at), { fillColor: 'red' });
  b.roomShort(filled, 1);
  b.sent.length = 0;
  for (const id of [a1, a2]) crud.updateElement(id, { fillColor: 'red' });
  expect(b.sent).toEqual([]);
  await Promise.resolve();
  b.roomShort(filled, 0);
  for (const id of [a1, a2]) crud.updateElement(id, { fillColor: 'red' });
  expect(b.sent).not.toEqual([]);
  await Promise.resolve();
  // A mode change on two labelled connectors: each its mode and label.
  b.gfx.selection.set({ editing: false, elements: labelled });
  const moded = updated(labelled.map(b.at), { mode: 1 });
  expect(moded.values).toBe(4);
  b.roomShort(moded, 1);
  b.sent.length = 0;
  for (const id of labelled) crud.updateElement(id, { mode: 1 });
  expect(b.sent).toEqual([]);
  await Promise.resolve();
  b.roomShort(moded, 0);
  for (const id of labelled) crud.updateElement(id, { mode: 1 });
  expect(b.sent).not.toEqual([]);
  await Promise.resolve();
  // A group of the selection, an add; an arrange of two notes, a place of
  // each (`updateBlock`, past the CRUD's gate).
  const root = b.store.root;
  if (!root) throw new Error('no root');
  const notes = [0, 900].map((x) =>
    b.store.addBlock('affine:note', { xywh: `[${x},900,200,80]` }, root)
  );
  b.gfx.selection.set({ editing: false, elements: notes });
  vi.mocked(userToast).mockClear();
  b.sent.length = 0;
  const arranged = b.written(
    notes.map((id) => b.store.getModelById(id) as NoteBlockModel),
    'place'
  );
  expect(arranged.values).toBe(12);
  b.std.command.exec(createGroupFromSelectedCommand);
  b.roomShort(arranged, 1);
  b.std.command.exec(autoArrangeElementsCommand);
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledTimes(2);
  b.roomShort(arranged, 0);
  b.std.command.exec(autoArrangeElementsCommand);
  expect(b.sent).not.toEqual([]);
  // A mind map's Style, through the board's count.
  const styled = b.written([map], 'style');
  b.roomShort(styled, 1);
  expect(boardWrites.refuses(b.store, [map], 'style')).toBe(true);
  b.roomShort(styled, 0);
  expect(boardWrites.refuses(b.store, [map], 'style')).toBe(false);
});
