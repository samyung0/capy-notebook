import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import {
  DefaultTool,
  EdgelessCRUDExtension,
  EdgelessCRUDIdentifier,
  type SurfaceBlockModel,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ungroupCommand } from '@blocksuite/affine/gfx/group';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import { MindMapDragExtension } from '@blocksuite/affine/gfx/mindmap';
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import type {
  MindmapElementModel,
  NoteBlockModel,
} from '@blocksuite/affine/model';
import type { ToolbarContext } from '@blocksuite/affine/shared/services';
import { EditPropsStore } from '@blocksuite/affine/shared/services';
import { BlockStdScope, type PointerEventState } from '@blocksuite/affine/std';
import {
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
import { builtinMiscToolbarConfig } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/misc';
import { moreActions } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/more';
import { Slider } from '../../../vendor/blocksuite/affine/components/src/slider/slider';
import { boardFirstState } from './boardFirstState';
import { openRoomStore } from './roomStore';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const {
  BOARD_WRITE_BYTES,
  gateCommands,
  gateElementUpdates,
  gateSelectionWrites,
  gateToolbarWrites,
  setBoardFull,
  setBoardSizer,
  writesOf,
} = await import('./boardFull');

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
  /** Leaves room for `values` values' stubs. */
  const roomFor = (values: number) => {
    bytes = MAX - BOARD_WRITE_BYTES * values;
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
  return { at, doc, gfx, roomFor, sent, shape, std, store, surface, written };
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

/** The connector watcher works a microtask after a change. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

// Review of 8d813a7cc, findings 1, 2 and 5: what a gesture writes is every
// element it reaches, each with every value it writes there. Fails if a
// group counts as one, a mind map's node as one, or a connector, a text
// label's resize, a stroke's resize or a rotation as one value each.
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
  // The group (nothing of its own), its two shapes, and the label of the
  // connector hanging on one of them.
  expect(b.written([b.at(g)], 'move')).toEqual({ elements: 4, values: 3 });
  // A node moves its whole map: the map's tree and both nodes.
  expect(b.written([b.at(node)], 'move')).toEqual({ elements: 3, values: 3 });
  // A connector moved with its ends: its free ends and label, at most.
  expect(b.written([b.at(hanging), b.at(a1), b.at(x)], 'move')).toEqual({
    elements: 3,
    values: 5,
  });
  // A text label's resize writes its box and font size, a stroke's its box
  // and points; the shape's box moves the label hanging on it.
  expect(b.written([b.at(text), b.at(stroke), b.at(x)], 'resize')).toEqual({
    elements: 4,
    values: 6,
  });
  // A rotation writes an angle and a place.
  expect(b.written([b.at(text), b.at(stroke)], 'rotate')).toEqual({
    elements: 2,
    values: 4,
  });
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
  b.roomFor(1);
  await drag();
  expect(started.handleElementMove).not.toHaveBeenCalled();
  expect(userToast).toHaveBeenCalledOnce();
  b.roomFor(2);
  await drag();
  expect(started.handleElementMove).toHaveBeenCalledOnce();

  // What the selection frame calls at a press on its handles.
  const frame = b.std.getOptional(InteractivityIdentifier);
  const elements = [b.at(a1), b.at(a2)];
  b.roomFor(3);
  frame?.handleElementRotate({ elements } as never);
  expect(started.handleElementRotate).not.toHaveBeenCalled();
  frame?.handleElementResize({ elements } as never);
  expect(started.handleElementResize).toHaveBeenCalledOnce();
  b.roomFor(4);
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
    ids.includes(id) ? ids.length : 0
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
    () => ({ elements: 0, values: 0 })
  );
  b.roomFor(1);
  b.sent.length = 0;
  const [refused] = b.std.command.exec(ungroupCommand, {
    group: b.at(outer) as never,
  });
  expect(refused).toBe(false);
  expect(b.sent).toEqual([]);
  b.roomFor(2);
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
  const stop = gateToolbarWrites(b.store, (models) =>
    b.written(models, 'place')
  );
  onTestFinished(stop);
  b.roomFor(10);
  b.sent.length = 0;
  const models = [b.at(a1), b.at(x)];
  action(builtinMiscToolbarConfig.actions, 'b.lock').run(toolbar(b, models));
  expect(b.sent).toEqual([]);
  expect(b.at(a1).group).not.toBeNull();
  b.roomFor(1);
  action(moreActions, 'a.bring-to-front').run(toolbar(b, models));
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledTimes(2);
  b.roomFor(2);
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
  const stop = gateToolbarWrites(b.store, (each) => b.written(each, 'place'));
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
  b.roomFor(4);
  b.sent.length = 0;
  align();
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  b.roomFor(5);
  align();
  expect(b.sent).not.toEqual([]);
});

// Leftovers of 0366a0a15, item 2 (local change 82): a note's Scale writes
// each note's box and scale straight to the block. Fails if a refused Scale
// writes any note.
it("refuses a note's Scale of several notes past a full board before any is scaled", () => {
  const b = board();
  const root = b.store.root;
  if (!root) throw new Error('no root');
  const notes = [0, 300].map(
    (x) =>
      b.store.getModelById(
        b.store.addBlock('affine:note', { xywh: `[${x},0,200,80]` }, root)
      ) as NoteBlockModel
  );
  const stop = gateToolbarWrites(b.store, (each) => b.written(each, 'place'));
  onTestFinished(stop);
  let module: { config: { actions: unknown[] } } | undefined;
  for (const extension of createBuiltinToolbarConfigExtension('affine:note'))
    extension.setup({
      addImpl: (_: unknown, impl: typeof module) => {
        module = impl;
      },
    } as never);
  const scale = (percent: number) => {
    const menu = (
      action(module?.config.actions ?? [], 'g.scale') as unknown as Content
    ).content(toolbar(b, notes));
    handlers(menu, '@select')[0](
      new CustomEvent('select', { detail: percent })
    );
  };
  b.roomFor(3);
  b.sent.length = 0;
  scale(200);
  expect(b.sent).toEqual([]);
  expect(userToast).toHaveBeenCalledOnce();
  b.roomFor(4);
  scale(200);
  expect(notes.map((note) => note.props.edgeless.scale)).toEqual([2, 2]);
});

// Leftovers of 0366a0a15, item 2 (local change 84): the width slider picked
// again at every pointer move, the value unchanged too, and each pick
// rewrites every selected element's width. Fails if a move that keeps the
// value picks.
it('picks a width once a drag, as it changes, not at every move', () => {
  const picked: number[] = [];
  // The slider as it stands, unrendered: 100 px wide, four widths.
  const slider = Object.create(Slider.prototype, {
    _onSelect: { value: (value: number) => picked.push(value) },
    getBoundingClientRect: { value: () => ({ width: 100 }) },
    range: { value: { points: [2, 4, 6, 8] } },
    sliderStyle: { value: undefined },
    value: { value: 4 },
  }) as {
    _picked: number | null;
    _updateLineWidthPanelByDragHandlePosition: (x: number) => void;
    value: number;
  };
  const move = (x: number) =>
    slider._updateLineWidthPanelByDragHandlePosition(x);
  // A press starts from the shown width.
  slider._picked = slider.value;
  for (const x of [40, 41, 42, 90, 91, 92, 40]) move(x);
  expect(picked).toEqual([8, 4]);
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
  const stop = gateToolbarWrites(b.store, (each) => b.written(each, 'place'));
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
