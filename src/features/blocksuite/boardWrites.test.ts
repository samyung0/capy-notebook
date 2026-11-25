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
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
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
// BlockSuite's element toolbar actions, which its root entry doesn't export.
import { builtinMiscToolbarConfig } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/misc';
import { moreActions } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/configs/toolbar/more';
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
