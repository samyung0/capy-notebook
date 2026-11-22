import { ImageStoreExtension } from '@blocksuite/affine/blocks/image/store';
import { ListStoreExtension } from '@blocksuite/affine/blocks/list/store';
import { setNotesInline } from '@blocksuite/affine/blocks/note';
import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import {
  type ClipboardConfigCreationContext,
  EdgelessCRUDIdentifier,
  type SurfaceBlockModel,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import {
  type ConnectorElementModel,
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
  FontStyle,
  FontWeight,
  LayoutType,
  type MindmapElementModel,
  MindmapStyle,
  type NoteBlockModel,
  NoteDisplayMode,
  NoteShadow,
  PointStyle,
  ShapeStyle,
  ShapeType,
  StrokeStyle,
  TextAlign,
  TextResizing,
  TextVerticalAlign,
} from '@blocksuite/affine/model';
import type { BlockStdScope } from '@blocksuite/affine/std';
import type {
  GfxPrimitiveElementModel,
  SerializedElement,
} from '@blocksuite/affine/std/gfx';
import { type Store, Text } from '@blocksuite/affine/store';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import { keyedElements, writeElements } from '@/features/graph/keyed';
import type { GraphElement } from '@/features/graph/model';
// BlockSuite's canvas paste, which its package doesn't export.
import { createCanvasElement } from '../../../vendor/blocksuite/affine/blocks/root/src/edgeless/clipboard/canvas';
import { CardsStoreExtension } from './boardCards';
import { type ChartElementModel, firstSpokes } from './boardChart';
import {
  BARS_MAX,
  type ChartBar,
  ELEMENTS_MAX,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  LATEX_MAX,
  type PieLabel,
  type PieSpoke,
  SPOKES_MAX,
} from './boardData';
import { boardFirstState } from './boardFirstState';
import { PICTURE_FLAVOUR, PictureStoreExtension } from './boardPicture';
// The plane's and formula's modules register their element types.
import './boardFormula';
import { checkSavedBoard, storedElementFits } from './boardLoad';
import type { PlaneElementModel } from './boardPlane';
import { ENUMS } from './boardRules';
import { unknownStore } from './boardUnknown';
import { openRoomStore } from './roomStore';

/* The board's rules (boardRules.ts) on one corpus, read as a board reads them
 * (boardLoad.ts): what BlockSuite's own model code writes for every element type
 * and block flavour, each card at its limits, keyed lists at twice their cap, and
 * one broken write per rule kind. Each case is a run of updates from the canvas's
 * first state, as an editor sends them: the board shows everything after every one
 * but the last, and after the last only when it `fits` (else it draws a
 * placeholder). */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  ListStoreExtension,
  ImageStoreExtension,
  BrushStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
  TextStoreExtension,
  GroupStoreExtension,
  MindmapStoreExtension,
  PictureStoreExtension,
  CardsStoreExtension,
]);

/** Updates applied from the room, which a tab doesn't send back. */
const ROOM = 'room';
const EDITOR_CLIENT = 7;

const firstState = () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState(), ROOM);
  return doc;
};

/** One tab's store on the canvas's room, as `mountDrawingBoard` opens it. */
function openTab() {
  const doc = new Y.Doc();
  doc.clientID = EDITOR_CLIENT;
  Y.applyUpdate(doc, boardFirstState(), ROOM);
  const { dispose, store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_corpus',
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  return { dispose, doc, store, surface };
}
type Tab = ReturnType<typeof openTab>;

/** The writers a case's steps use: a tab's BlockSuite store (`editor`), or a
 * plain document (another build or a tampered client) holding the first `upTo`
 * updates (`raw`). */
type Steps = {
  editor: (write: (tab: Tab) => void) => Promise<void>;
  raw: (write: (doc: Y.Doc) => void, upTo?: number) => void;
};
type Case = { fits: boolean; name: string; steps: (s: Steps) => Promise<void> };

const settled = () => new Promise((done) => setTimeout(done, 0));

/** A case's updates, each what one step wrote, merged. */
async function updatesOf({ steps }: Case) {
  const updates: Uint8Array[] = [];
  let tab: Tab | undefined;
  const taking = (doc: Y.Doc) => {
    const made: Uint8Array[] = [];
    const take = (update: Uint8Array, origin: unknown) => {
      if (origin !== ROOM) made.push(update);
    };
    doc.on('update', take);
    return () => {
      doc.off('update', take);
      if (made.length) updates.push(Y.mergeUpdates(made));
    };
  };
  const caughtUp = () => {
    tab ??= openTab();
    for (const update of updates) Y.applyUpdate(tab.doc, update, ROOM);
    return tab;
  };
  let raws = 0;
  await steps({
    editor: async (write) => {
      const current = caughtUp();
      const done = taking(current.doc);
      write(current);
      // The connector watcher writes a microtask after a change.
      await settled();
      done();
    },
    raw: (write, upTo = updates.length) => {
      const doc = firstState();
      raws += 1;
      doc.clientID = EDITOR_CLIENT + raws;
      for (const update of updates.slice(0, upTo))
        Y.applyUpdate(doc, update, ROOM);
      const done = taking(doc);
      write(doc);
      done();
    },
  });
  tab?.dispose();
  return updates;
}

/** Whether a board opens with nothing drawn as a placeholder: its load check
 * (`checkSavedBoard`: every block and element, the block tree, each mind map's
 * nodes) finds no misfit, and every element is read for real as it is live. */
function boardFits(board: Y.Doc) {
  if (checkSavedBoard(Y.encodeStateAsUpdate(board), 'workspace').misfits.length)
    return false;
  return [...canvasOf(board).entries()].every(([id, element]) =>
    storedElementFits(id, element, 'workspace')
  );
}

/** Each update applied in turn from the first state: whether the board fits
 * after it. */
function verdicts(updates: Uint8Array[]) {
  const board = firstState();
  return updates.map((update) => {
    Y.applyUpdate(board, update, ROOM);
    return boardFits(board);
  });
}

// What BlockSuite's own writers put down.

const canvasOf = (doc: Y.Doc) =>
  (
    (doc.getMap<Y.Map<unknown>>('blocks').get('surface') as Y.Map<unknown>).get(
      'prop:elements'
    ) as Y.Map<unknown>
  ).get('value') as Y.Map<Y.Map<unknown>>;
const elementIn = (doc: Y.Doc, type: string) => {
  for (const [id, element] of canvasOf(doc).entries())
    if (element.get('type') === type) return { element, id };
  throw new Error(`no ${type} on the canvas`);
};
const blockIn = (doc: Y.Doc, flavour: string) => {
  for (const [id, block] of doc.getMap<Y.Map<unknown>>('blocks').entries())
    if (block.get('sys:flavour') === flavour) return { block, id };
  throw new Error(`no ${flavour} block`);
};
const mapOf = (entries: Record<string, unknown>) => {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
};
/** An element put down whole by a tampered client. */
const putElement = (doc: Y.Doc, id: string, fields: Record<string, unknown>) =>
  canvasOf(doc).set(id, mapOf({ id, ...fields }) as Y.Map<unknown>);
/** A block put down whole under `parent` by a tampered client. */
function putBlock(
  doc: Y.Doc,
  id: string,
  parent: string,
  fields: Record<string, unknown>
) {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  doc.transact(() => {
    blocks.set(
      id,
      mapOf({ 'sys:children': new Y.Array(), ...fields }) as Y.Map<unknown>
    );
    (blocks.get(parent)!.get('sys:children') as Y.Array<string>).push([id]);
  });
}

/** A note put down whole on the page, with `props`. */
const putNote = (doc: Y.Doc, props: Record<string, unknown>) =>
  putBlock(doc, 'note', 'page', {
    'prop:xywh': '[0,0,10,10]',
    'sys:flavour': 'affine:note',
    ...props,
  });
/** A bar chart put down whole holding `bars`. */
const putBars = <E extends { id: string }>(doc: Y.Doc, ...bars: E[]) =>
  putElement(doc, 'c', {
    axisMax: 10,
    axisStep: 2,
    bars: mapOf(keyedElements(bars)),
    kind: 'bar',
    labels: new Y.Map(),
    spokes: new Y.Map(),
    type: 'chart',
    xywh: '[0,0,320,240]',
  });

/** A shape as the shape tool places it, with the style the last one used. */
const SHAPE = {
  color: '#000000',
  fillColor: '#ffffff',
  filled: true,
  fontFamily: 'blocksuite:surface:Inter',
  fontSize: 20,
  fontStyle: FontStyle.Normal,
  fontWeight: FontWeight.Regular,
  radius: 0,
  roughness: 1.4,
  shapeStyle: ShapeStyle.General,
  shapeType: ShapeType.Rect,
  strokeColor: '#000000',
  strokeStyle: StrokeStyle.Solid,
  strokeWidth: 4,
  textAlign: TextAlign.Center,
  type: 'shape',
  xywh: '[0,0,100,100]',
};
const addShape = (surface: SurfaceBlockModel, x = 0) =>
  surface.addElement({ ...SHAPE, xywh: `[${x},0,100,100]` });

/** A paste or duplicate: the element again from its copy, as BlockSuite's
 * canvas clipboard puts one down. */
function paste(surface: SurfaceBlockModel, id: string) {
  const model = surface.getElementById(id) as GfxPrimitiveElementModel;
  const { id: _, ...copy } = structuredClone(model.serialize()) as Record<
    string,
    unknown
  >;
  return surface.addElement({ ...copy, lockedBySelf: false, type: model.type });
}

/** A paste of `ids` through BlockSuite's canvas clipboard (`createCanvasElement`,
 * as `edgeless/clipboard/command.ts` calls it): each element's copy as the
 * clipboard carries it (JSON), 50 px over, its ids mapped to the pasted ones. The
 * std it asks for is the board's CRUD `addElement` (crud-extension.ts) without
 * the last-used style, which a paste's copy holds already. */
function pasteFromClipboard(surface: SurfaceBlockModel, ids: string[]) {
  const crud = {
    addElement: (type: string, props: Record<string, unknown>) =>
      surface.addElement({ ...props, type }),
    getElementById: (id: string) => surface.getElementById(id),
  };
  const std = {
    get: () => crud,
    getOptional: () => null,
  } as unknown as BlockStdScope;
  const context = {
    oldToNewIdMap: new Map<string, string>(),
  } as ClipboardConfigCreationContext;
  for (const id of ids) {
    const model = surface.getElementById(id) as GfxPrimitiveElementModel;
    const data = JSON.parse(
      JSON.stringify(model.serialize())
    ) as SerializedElement;
    const [x, y, w, h] = JSON.parse(model.xywh) as number[];
    const pasted = createCanvasElement(
      std,
      data,
      context,
      `[${x + 50},${y + 50},${w},${h}]`
    );
    if (!pasted) throw new Error(`${model.type} was not pasted`);
    context.oldToNewIdMap.set(id, pasted.id);
  }
}

/** The std `setNotesInline` asks for: the board's CRUD `updateElement` for a
 * block (crud-extension.ts, without last-used styles) and the selection, empty. */
const notesStd = (store: Store) =>
  ({
    get: (identifier: unknown) =>
      identifier === EdgelessCRUDIdentifier
        ? {
            updateElement: (id: string, props: Record<string, unknown>) => {
              const block = store.getModelById(id);
              if (block) store.updateBlock(block, props);
            },
          }
        : { selection: { clear() {}, selectedIds: [], set() {} } },
    store,
  }) as unknown as BlockStdScope;

const addChart = (surface: SurfaceBlockModel, kind: 'bar' | 'pie') =>
  surface.addElement({
    axisMax: 10,
    axisStep: 2,
    bars: keyedElements<ChartBar>([]),
    kind,
    labels: keyedElements<PieLabel>([]),
    spokes: keyedElements(firstSpokes(kind)),
    type: 'chart',
    xywh: '[0,0,320,240]',
  });
const bar = (id: string, label = 'Mon'): ChartBar => ({
  fill: '#1e96eb',
  id,
  label,
  value: 3,
});
/** A chart's list written as its editor writes one. */
function writeChart(
  tab: Tab,
  id: string,
  key: 'bars' | 'labels' | 'spokes',
  list: (ChartBar | PieLabel | PieSpoke)[]
) {
  const chart = tab.surface.getElementById(id) as ChartElementModel;
  tab.store.transact(() => writeElements(chart[key], list));
}
const addPlane = (surface: SurfaceBlockModel) =>
  surface.addElement({
    elements: keyedElements([]),
    fit: false,
    polar: false,
    ppu: 30,
    type: 'plane',
    x0: -1,
    xywh: '[0,0,300,200]',
    y0: 4.6,
  });
const point = (id: string, x: number): GraphElement => ({
  coords: [x, 1],
  id,
  type: 'point',
});
/** A keyed list of `count` items, as a tampered client writes it in one go. */
const keyedOf = <E extends { id: string }>(
  count: number,
  item: (i: number) => E
) => mapOf(keyedElements(Array.from({ length: count }, (_, i) => item(i))));

const addNote = (store: Store) => {
  const root = store.root;
  if (!root) throw new Error('no page');
  return store.addBlock('affine:note', { xywh: '[0,200,300,100]' }, root);
};
const surfaceId = (tab: Tab) => tab.surface.id;
const addCard = (tab: Tab, flavour: string, props: Record<string, unknown>) =>
  tab.store.addBlock(
    flavour,
    { xywh: '[400,0,200,120]', ...props },
    surfaceId(tab)
  );
const klipy = (length: number) => {
  const head = 'https://static.klipy.com/';
  return `${head}${'a'.repeat(length - head.length - 5)}.webp`;
};
const address = (length: number) => {
  const head = 'https://example.com/';
  return head + 'a'.repeat(length - head.length);
};

const writes = (name: string, steps: Case['steps']): Case => ({
  fits: true,
  name,
  steps,
});
const misfits = (name: string, steps: Case['steps']): Case => ({
  fits: false,
  name,
  steps,
});

const CASES: Case[] = [
  // Elements, as each tool and editor writes them.
  writes('a pen stroke, its points written as the drag ends', async (s) => {
    await s.editor(({ surface }) => {
      const id = surface.addElement({ points: [[10, 10]], type: 'brush' });
      surface.updateElement(id, {
        points: [
          [10, 10, 0.5],
          [30, 25, 0.6],
          [60, 20, 0.4],
        ],
      });
    });
  }),
  writes('a mouse click with the pen, a dot', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        color: { dark: '#ffffff', light: '#000000' },
        lineWidth: 4,
        points: [[5, 5, 0]],
        type: 'brush',
      });
    });
  }),
  writes('a highlighter stroke', async (s) => {
    await s.editor(({ surface }) => {
      const id = surface.addElement({ points: [[0, 0]], type: 'highlighter' });
      surface.updateElement(id, {
        points: [
          [0, 0],
          [80, 10],
        ],
      });
    });
  }),
  writes('a shape and its text typed in, bold', async (s) => {
    await s.editor(({ surface }) => {
      const id = addShape(surface);
      const text = new Y.Text();
      surface.updateElement(id, { text });
      text.insert(0, 'Mitosis');
      text.format(0, 3, { bold: true });
    });
  }),
  writes('each polygon the shapes panel offers', async (s) => {
    await s.editor(({ surface }) => {
      for (const [i, shapeType] of Object.values(ShapeType).entries())
        surface.addElement({
          ...SHAPE,
          shapeType,
          xywh: `[${i * 120},0,100,100]`,
        });
    });
  }),
  writes(
    'a connector between two shapes, labelled, then its label cleared',
    async (s) => {
      await s.editor(({ surface }) => {
        const from = addShape(surface);
        const to = addShape(surface, 400);
        const id = surface.addElement({
          controllers: [],
          mode: ConnectorMode.Curve,
          source: { id: from, position: [1, 0.5] },
          target: { id: to, position: [0, 0.5] },
          type: 'connector',
        });
        const text = new Y.Text();
        surface.updateElement(id, {
          labelOffset: { anchor: 'center', distance: 0.5 },
          labelXYWH: [200, 40, 16, 16],
          text,
        });
        text.insert(0, 'divides');
      });
      await s.editor(({ surface }) => {
        const connector = surface.elementModels.find(
          (model) => model.type === 'connector'
        );
        if (!connector) throw new Error('no connector');
        surface.updateElement(connector.id, {
          labelOffset: undefined,
          labelXYWH: undefined,
          text: undefined,
        });
      });
    }
  ),
  // What the label editor writes (edgeless-connector-label-editor.ts, a view the
  // store alone can't mount): a text and a place as it opens (:52-70), the place
  // as the label grows (:140-159), and the text trimmed as it closes (:244-258).
  writes(
    "a connector's label typed in its editor, trimmed as it closes",
    async (s) => {
      let id = '';
      await s.editor(({ surface }) => {
        // Curved: an elbow's path needs the DOM's DOMRect, which the store has not.
        id = surface.addElement({
          mode: ConnectorMode.Curve,
          source: { id: addShape(surface) },
          target: { id: addShape(surface, 400) },
          type: 'connector',
        });
        const connector = surface.getElementById(id) as ConnectorElementModel;
        surface.updateElement(id, {
          labelOffset: { ...connector.labelOffset },
          labelXYWH: connector.labelXYWH ?? [0, 0, 16, 16],
          text: new Y.Text(),
        });
      });
      await s.editor(({ surface }) => {
        const connector = surface.getElementById(id) as ConnectorElementModel;
        connector.text?.insert(0, ' Anaphase ');
        surface.updateElement(id, { labelXYWH: [182, 38, 96, 24] });
      });
      await s.editor(({ surface }) => {
        surface.updateElement(id, { text: new Y.Text('Anaphase') });
      });
    }
  ),
  writes('a connector drawn from a point to a point', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        frontEndpointStyle: PointStyle.None,
        mode: ConnectorMode.Straight,
        rearEndpointStyle: PointStyle.Arrow,
        source: { position: [0, 0] },
        stroke: '#000000',
        strokeWidth: 2,
        target: { position: [120, 40] },
        type: 'connector',
      });
    });
  }),
  writes('a text typed with the text tool', async (s) => {
    await s.editor(({ surface }) => {
      const text = new Y.Text();
      surface.addElement({ text, type: 'text', xywh: '[0,0,32,32]' });
      text.insert(0, 'Prophase');
    });
  }),
  writes('two shapes grouped', async (s) => {
    await s.editor(({ surface }) => {
      const a = addShape(surface);
      const b = addShape(surface, 200);
      surface.addElement({
        children: { [a]: true, [b]: true },
        title: 'Group 1',
        type: 'group',
      });
    });
  }),
  writes('the mind map Misc puts down', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        children: {
          children: [0, 1, 2].map((i) => ({
            children: [],
            text: 'Idea',
            xywh: `[265,${i * 50},80,35]`,
          })),
          text: 'Topic',
          xywh: '[0,0,145,50]',
        },
        layoutType: LayoutType.RIGHT,
        style: MindmapStyle.ONE,
        type: 'mindmap',
      });
    });
  }),
  writes("a mind map's node given a child, then folded", async (s) => {
    let id = '';
    await s.editor(({ surface }) => {
      id = surface.addElement({
        children: {
          children: [{ children: [], text: 'Idea', xywh: '[265,0,80,35]' }],
          text: 'Topic',
          xywh: '[0,0,145,50]',
        },
        layoutType: LayoutType.RIGHT,
        style: MindmapStyle.ONE,
        type: 'mindmap',
      });
    });
    const idea = (surface: SurfaceBlockModel) => {
      const mindmap = surface.getElementById(id) as MindmapElementModel;
      const [node] = mindmap.tree.children;
      return { mindmap, node };
    };
    await s.editor(({ surface }) => {
      const { mindmap, node } = idea(surface);
      mindmap.addNode(node.id);
    });
    await s.editor(({ surface }) => {
      const { mindmap, node } = idea(surface);
      mindmap.toggleCollapse(node);
    });
  }),
  writes('a plane card, and two points and a line in its editor', async (s) => {
    await s.editor((tab) => {
      const id = addPlane(tab.surface) as string;
      const plane = tab.surface.getElementById(id) as PlaneElementModel;
      tab.store.transact(() =>
        writeElements(plane.elements, [
          point('a', 0),
          point('b', 2),
          { id: 'l', points: ['a', 'b'], type: 'segment' },
        ] as GraphElement[])
      );
    });
  }),
  writes('a bar chart and its bars', async (s) => {
    await s.editor((tab) => {
      const id = addChart(tab.surface, 'bar') as string;
      writeChart(tab, id, 'bars', [bar('mon'), bar('tue', 'Tue')]);
    });
  }),
  writes('a pie chart, its lines filled and a label', async (s) => {
    await s.editor((tab) => {
      const id = addChart(tab.surface, 'pie') as string;
      writeChart(tab, id, 'spokes', [
        { angle: 0, fill: '#e03131', id: 'first' },
        { angle: 120, fill: { dark: '#fff', light: '#000' }, id: 's2' },
      ]);
      writeChart(tab, id, 'labels', [
        { angle: 60, id: 'l1', reach: 0.6, size: 14, text: 'Walk' },
      ]);
    });
  }),
  writes('a formula card', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        latex: 'x^2',
        type: 'formula',
        xywh: '[0,0,60,30]',
      });
    });
  }),
  writes('a shape, a group, a plane and a chart pasted', async (s) => {
    await s.editor((tab) => {
      const shape = addShape(tab.surface);
      tab.surface.updateElement(shape, { text: new Y.Text('Copy me') });
      const other = addShape(tab.surface, 200);
      const group = tab.surface.addElement({
        children: { [shape]: true, [other]: true },
        title: 'Group 1',
        type: 'group',
      });
      const plane = addPlane(tab.surface) as string;
      const chart = addChart(tab.surface, 'bar') as string;
      writeChart(tab, chart, 'bars', [bar('mon')]);
      for (const id of [shape, group, plane, chart]) paste(tab.surface, id);
    });
  }),
  writes(
    "a shape, a connector, a group, a mind map and a text pasted through the canvas's clipboard",
    async (s) => {
      await s.editor(({ surface }) => {
        const shape = addShape(surface);
        surface.updateElement(shape, { text: new Y.Text('Copy me') });
        const other = addShape(surface, 200);
        const connector = surface.addElement({
          mode: ConnectorMode.Straight,
          source: { id: shape },
          target: { id: other },
          type: 'connector',
        });
        const group = surface.addElement({
          children: { [shape]: true, [other]: true },
          title: 'Group 1',
          type: 'group',
        });
        const mindmap = surface.addElement({
          children: {
            children: [{ children: [], text: 'Idea', xywh: '[265,0,80,35]' }],
            text: 'Topic',
            xywh: '[0,0,145,50]',
          },
          layoutType: LayoutType.RIGHT,
          style: MindmapStyle.ONE,
          type: 'mindmap',
        });
        const nodes = [
          ...(
            surface.getElementById(mindmap) as MindmapElementModel
          ).children.keys(),
        ];
        const text = surface.addElement({
          text: new Y.Text('Prophase'),
          type: 'text',
          xywh: '[0,400,100,30]',
        });
        // What a group or a mind map holds goes before it, as the copy orders it.
        pasteFromClipboard(surface, [
          shape,
          other,
          connector,
          group,
          ...nodes,
          mindmap,
          text,
        ]);
      });
    }
  ),
  writes('a shape deleted and brought back by Undo', async (s) => {
    await s.editor(({ store, surface }) => {
      const id = addShape(surface);
      store.captureSync();
      surface.deleteElement(id);
      store.captureSync();
      store.undo();
    });
  }),
  // Blocks, as the store writes them.
  writes(
    'a note with a paragraph typed in, a heading and a to-do',
    async (s) => {
      await s.editor(({ store }) => {
        const note = addNote(store);
        const text = new Text('Light reactions');
        store.addBlock('affine:paragraph', { text, type: 'h2' }, note);
        text.format(0, 5, { italic: true });
        store.addBlock(
          'affine:list',
          { checked: true, text: new Text('Read p. 12'), type: 'todo' },
          note
        );
      });
    }
  ),
  // A footnote, as its markdown matcher reads one: a space whose format is an
  // object (affine/inlines/footnote/src/adapters/markdown/markdown-inline.ts).
  writes('a paragraph whose text carries a footnote', async (s) => {
    await s.editor(({ store }) => {
      const text = new Text('Mitosis');
      store.addBlock('affine:paragraph', { text }, addNote(store));
      text.insert(' ', 7, {
        footnote: {
          label: '1',
          reference: {
            title: 'Cell division',
            type: 'url',
            url: 'https://example.com/mitosis',
          },
        },
      });
    });
  }),
  writes('a note turned inline, then back into a card', async (s) => {
    let note = '';
    await s.editor(({ store }) => {
      note = addNote(store);
      store.addBlock('affine:paragraph', { text: new Text('Osmosis') }, note);
    });
    for (const inline of [true, false])
      await s.editor(({ store }) => {
        setNotesInline(
          notesStd(store),
          [store.getModelById(note) as NoteBlockModel],
          inline
        );
      });
  }),
  writes('an image on the canvas and in a note', async (s) => {
    await s.editor((tab) => {
      tab.store.addBlock(
        'affine:image',
        {
          height: 180,
          size: 1240,
          sourceId: 'asset_1',
          width: 320,
          xywh: '[0,300,320,180]',
        },
        surfaceId(tab)
      );
      const note = addNote(tab.store);
      tab.store.addBlock('affine:image', { sourceId: 'asset_2' }, note);
    });
  }),
  // An image pasted with the caret in an indented line lands under that line
  // (page-clipboard.ts:150-155), and Tab on an image puts it under the block before
  // it (indent-block.ts:40-61, `store.moveBlocks` where the schema takes it).
  writes(
    'images under a list item, a paragraph and an image in a note',
    async (s) => {
      await s.editor(({ store }) => {
        const note = addNote(store);
        const item = store.addBlock(
          'affine:list',
          { text: new Text('Mitosis'), type: 'bulleted' },
          note
        );
        store.addBlock('affine:image', { sourceId: 'asset_1' }, item);
        const line = store.addBlock(
          'affine:paragraph',
          { text: new Text('Anaphase') },
          note
        );
        const first = store.addBlock(
          'affine:image',
          { sourceId: 'asset_2' },
          note
        );
        /** Tab: under the block before, which must be `parent`. */
        const indent = (id: string, parent: string) => {
          const model = store.getModelById(id);
          const before = model && store.getPrev(model);
          if (
            !(before && store.schema.isValid(model.flavour, before.flavour)) ||
            before.id !== parent
          )
            throw new Error(`nothing to indent ${id} under`);
          store.moveBlocks([model], before);
        };
        indent(first, line);
        const second = store.addBlock(
          'affine:image',
          { sourceId: 'asset_3' },
          line
        );
        const third = store.addBlock(
          'affine:image',
          { sourceId: 'asset_4' },
          line
        );
        indent(third, second);
      });
    }
  ),
  writes('an emoji and a GIF', async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'emoji',
        label: '🧠',
        ref: '1f9e0',
      });
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'klipy',
        label: 'Wave',
        ref: 'https://static.klipy.com/ii/a/b.webp',
      });
    });
  }),
  writes('a YouTube link and a quiz card', async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-link', {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
      });
      addCard(tab, 'affine:embed-capy-material', {
        kind: 'quiz',
        materialId: 'qz_1',
        title: 'Cell cycle',
      });
    });
  }),

  // Each card at its limits.
  writes('a GIF link and a label at their longest', async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'klipy',
        label: 'a'.repeat(BOARD_CATALOG.limits.PICTURE_LABEL_MAX),
        ref: klipy(BOARD_CATALOG.limits.PICTURE_REF_MAX),
      });
    });
  }),
  misfits('a GIF link one past its longest', async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'klipy',
        label: '',
        ref: klipy(BOARD_CATALOG.limits.PICTURE_REF_MAX + 1),
      });
    });
  }),
  misfits("a picture's label one past its longest", async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'emoji',
        label: 'a'.repeat(BOARD_CATALOG.limits.PICTURE_LABEL_MAX + 1),
        ref: '1f9e0',
      });
    });
  }),
  writes('a link at its longest', async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-link', {
        url: address(BOARD_CATALOG.limits.LINK_URL_MAX),
        videoId: '',
      });
    });
  }),
  misfits('a link one past its longest', async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-link', {
        url: address(BOARD_CATALOG.limits.LINK_URL_MAX + 1),
        videoId: '',
      });
    });
  }),
  misfits('a link to a script', async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-link', {
        url: 'javascript:alert(1)',
        videoId: '',
      });
    });
  }),
  misfits("a link whose video id isn't one", async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-link', {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXc',
      });
    });
  }),
  writes("a material card's id and title at their longest", async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-material', {
        kind: 'flashcards',
        materialId: 'f'.repeat(BOARD_CATALOG.limits.MATERIAL_ID_MAX),
        title: 't'.repeat(BOARD_CATALOG.limits.CARD_TITLE_MAX),
      });
    });
  }),
  misfits("a material card's title one past its longest", async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-material', {
        kind: 'quiz',
        materialId: 'qz_1',
        title: 't'.repeat(BOARD_CATALOG.limits.CARD_TITLE_MAX + 1),
      });
    });
  }),
  misfits('a material card with no id', async (s) => {
    await s.editor((tab) => {
      addCard(tab, 'affine:embed-capy-material', {
        kind: 'quiz',
        materialId: '',
        title: 'Cell cycle',
      });
    });
  }),
  writes('a formula at its longest', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        latex: 'x'.repeat(LATEX_MAX),
        type: 'formula',
        xywh: '[0,0,60,30]',
      });
    });
  }),
  misfits('a formula one past its longest', async (s) => {
    await s.editor(({ surface }) => {
      surface.addElement({
        latex: 'x'.repeat(LATEX_MAX + 1),
        type: 'formula',
        xywh: '[0,0,60,30]',
      });
    });
  }),
  misfits("a bar's label one past its longest", async (s) => {
    await s.editor((tab) => {
      const id = addChart(tab.surface, 'bar') as string;
      writeChart(tab, id, 'bars', [
        bar('mon', 'm'.repeat(LABEL_LENGTH_MAX + 1)),
      ]);
    });
  }),
  misfits("a pie label's size past the largest", async (s) => {
    await s.editor((tab) => {
      const id = addChart(tab.surface, 'pie') as string;
      writeChart(tab, id, 'labels', [
        {
          angle: 0,
          id: 'l',
          reach: 0.5,
          size: BOARD_CATALOG.limits.TEXT_SIZE_MAX + 1,
          text: 'Walk',
        },
      ]);
    });
  }),

  // Keyed lists: two people's adds at once merge up to twice the cap (Epo
  // 2026-11-22, "sure A"), never past it.
  writes("two people's bars merged to twice the cap", async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'bar');
    });
    const adds = (tag: string) => (doc: Y.Doc) => {
      const bars = elementIn(doc, 'chart').element.get(
        'bars'
      ) as Y.Map<unknown>;
      doc.transact(() => {
        for (const [id, entry] of Object.entries(
          keyedElements(
            Array.from({ length: BARS_MAX }, (_, i) => bar(`${tag}${i}`))
          )
        ))
          bars.set(id, entry);
      });
    };
    s.raw(adds('a'), 1);
    s.raw(adds('b'), 1);
  }),
  misfits('one bar past twice the cap', async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'bar');
    });
    s.raw((doc) => {
      const { element } = elementIn(doc, 'chart');
      element.set(
        'bars',
        keyedOf(2 * BARS_MAX + 1, (i) => bar(`b${i}`))
      );
    });
  }),
  writes("a pie's labels and lines at twice their caps", async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'pie');
    });
    s.raw((doc) => {
      const { element } = elementIn(doc, 'chart');
      doc.transact(() => {
        element.set(
          'labels',
          keyedOf(2 * LABELS_MAX, (i) => ({
            angle: i,
            id: `l${i}`,
            reach: 0.5,
            text: 'A',
          }))
        );
        element.set(
          'spokes',
          keyedOf(2 * SPOKES_MAX, (i) => ({ angle: i, id: `s${i}` }))
        );
      });
    });
  }),
  misfits('one pie label past twice the cap', async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'pie');
    });
    s.raw((doc) => {
      elementIn(doc, 'chart').element.set(
        'labels',
        keyedOf(2 * LABELS_MAX + 1, (i) => ({
          angle: i,
          id: `l${i}`,
          reach: 0.5,
          text: 'A',
        }))
      );
    });
  }),
  misfits('one pie line past twice the cap', async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'pie');
    });
    s.raw((doc) => {
      elementIn(doc, 'chart').element.set(
        'spokes',
        keyedOf(2 * SPOKES_MAX + 1, (i) => ({ angle: i, id: `s${i}` }))
      );
    });
  }),
  writes("a plane's elements at twice the cap", async (s) => {
    await s.editor((tab) => {
      addPlane(tab.surface);
    });
    s.raw((doc) => {
      elementIn(doc, 'plane').element.set(
        'elements',
        keyedOf(2 * ELEMENTS_MAX, (i) => point(`p${i}`, i))
      );
    });
  }),
  misfits('one plane element past twice the cap', async (s) => {
    await s.editor((tab) => {
      addPlane(tab.surface);
    });
    s.raw((doc) => {
      elementIn(doc, 'plane').element.set(
        'elements',
        keyedOf(2 * ELEMENTS_MAX + 1, (i) => point(`p${i}`, i))
      );
    });
  }),

  // What another tab sends whole, which the misfits below each change once.
  writes('a shape as another tab sends it', async (s) => {
    s.raw((doc) => putElement(doc, 'a', SHAPE));
  }),
  writes('a connector as another tab sends it', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        mode: 2,
        source: { position: [0, 0] },
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  writes('a group of what is not there, as another tab sends it', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        children: mapOf({ gone: true }),
        title: new Y.Text(),
        type: 'group',
      })
    );
  }),
  // Two people's honest edits can break a mind map's nodes together: the board
  // draws it as a placeholder.
  misfits('a mind map whose node is not on the canvas', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        children: mapOf({ gone: { index: 'a0' } }),
        layoutType: 0,
        style: 1,
        type: 'mindmap',
      })
    );
  }),
  writes('a note and a picture put down whole', async (s) => {
    s.raw((doc) => {
      putBlock(doc, 'note', 'page', {
        'prop:xywh': '[0,0,10,10]',
        'sys:flavour': 'affine:note',
      });
      putBlock(doc, 'pic', 'surface', {
        'prop:kind': 'emoji',
        'prop:label': '',
        'prop:ref': '1f9e0',
        'prop:rotate': 0,
        'prop:xywh': '[0,0,96,96]',
        'sys:flavour': PICTURE_FLAVOUR,
      });
    });
  }),

  writes(
    'a paragraph with who wrote it and when, and an unset alignment',
    async (s) => {
      s.raw((doc) => {
        putBlock(doc, 'note', 'page', {
          'prop:xywh': '[0,0,10,10]',
          'sys:flavour': 'affine:note',
        });
        putBlock(doc, 'line', 'note', {
          'prop:meta:createdAt': 1_763_800_000_000,
          'prop:meta:createdBy': 'user_1',
          'prop:meta:updatedAt': 1_763_800_000_000,
          'prop:meta:updatedBy': 'user_1',
          'prop:text': new Y.Text('Osmosis'),
          'prop:textAlign': undefined,
          'sys:flavour': 'affine:paragraph',
        });
      });
    }
  ),
  writes('a colour with a normal and one of dark or light', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        ...SHAPE,
        strokeColor: { dark: '#fff', normal: '#000' },
      })
    );
  }),

  writes('a note background map of dark and light', async (s) => {
    s.raw((doc) =>
      putNote(doc, {
        'prop:background': mapOf({ dark: '#000', light: '#fff' }),
      })
    );
  }),
  writes('a note background map of normal', async (s) => {
    s.raw((doc) =>
      putNote(doc, { 'prop:background': mapOf({ normal: '#888' }) })
    );
  }),

  // One misfit per rule kind, each from a tampered client.
  misfits('a shape with no shape type', async (s) => {
    const { shapeType: _, ...shape } = SHAPE;
    s.raw((doc) => putElement(doc, 'a', shape));
  }),
  misfits(
    'a colour with dark and light, one no string, though its normal is',
    async (s) => {
      s.raw((doc) =>
        putElement(doc, 'a', {
          ...SHAPE,
          strokeColor: { dark: '#fff', light: 1, normal: '#000' },
        })
      );
    }
  ),
  misfits('a bar whose fill is no colour', async (s) => {
    s.raw((doc) => putBars(doc, { ...bar('mon'), fill: 7 }));
  }),
  misfits('a bigint where a number belongs (a bar value)', async (s) => {
    s.raw((doc) => putBars(doc, { ...bar('mon'), value: BigInt(3) }));
  }),
  misfits('a paragraph type holding `undefined`', async (s) => {
    s.raw((doc) => {
      putBlock(doc, 'note', 'page', {
        'prop:xywh': '[0,0,10,10]',
        'sys:flavour': 'affine:note',
      });
      putBlock(doc, 'line', 'note', {
        'prop:type': undefined,
        'sys:flavour': 'affine:paragraph',
      });
    });
  }),
  misfits('a note whose edgeless map has no style', async (s) => {
    s.raw((doc) =>
      putNote(doc, { 'prop:edgeless': mapOf({ collapse: false }) })
    );
  }),
  misfits('a number that is not one (strokeWidth)', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, strokeWidth: 'thick' }));
  }),
  misfits('a colour that is not one', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', { ...SHAPE, strokeColor: { dark: '#fff' } })
    );
  }),
  misfits('a place that is not one', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, xywh: '[0,0,100]' }));
  }),
  misfits('a padding that is no pair', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, padding: [10] }));
  }),
  misfits('points that are not points', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', { points: [[1]], type: 'brush', xywh: '[0,0,1,1]' })
    );
  }),
  misfits("a connector's end on nothing", async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        mode: 2,
        source: {},
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  misfits("a connector's label box that is no box", async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        labelXYWH: [0, 0, 16],
        mode: 2,
        source: { position: [0, 0] },
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  misfits("a connector's label style missing its font", async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        labelStyle: {
          color: '#000',
          fontSize: 16,
          fontStyle: 'normal',
          fontWeight: '400',
          textAlign: 'center',
        },
        mode: 2,
        source: { position: [0, 0] },
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  misfits('a shadow that is not one', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        ...SHAPE,
        shadow: { blur: 'soft', color: '#000', offsetX: 0, offsetY: 0 },
      })
    );
  }),
  misfits('a shape type BlockSuite has not', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, shapeType: 'star' }));
  }),
  misfits('a connector mode BlockSuite has not', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        mode: 3,
        source: { position: [0, 0] },
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  misfits('a boolean that is not one', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, filled: 'yes' }));
  }),
  misfits('an element type the board does not hold', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', { type: 'hologram', xywh: '[0,0,1,1]' })
    );
  }),
  misfits('a key no element type has', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, tilt: 3 }));
  }),
  misfits('an element missing its place', async (s) => {
    const { xywh: _, ...unplaced } = SHAPE;
    s.raw((doc) => putElement(doc, 'a', unplaced));
  }),
  misfits('a map write that deletes a required key', async (s) => {
    await s.editor(({ surface }) => {
      addShape(surface);
    });
    s.raw((doc) => elementIn(doc, 'shape').element.delete('xywh'));
  }),
  misfits('a string where a text belongs', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        text: 'Prophase',
        type: 'text',
        xywh: '[0,0,9,9]',
      })
    );
  }),
  misfits('a map where a plain value belongs', async (s) => {
    s.raw((doc) => putElement(doc, 'a', { ...SHAPE, xywh: mapOf({ x: 0 }) }));
  }),
  misfits('an array where a map belongs', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        children: new Y.Array(),
        title: new Y.Text(),
        type: 'group',
      })
    );
  }),
  misfits('bytes, which are no plain value', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', { ...SHAPE, fontFamily: new Uint8Array([1]) })
    );
  }),
  misfits('bytes inside a plain value (a connector end)', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        mode: 2,
        source: { position: [0, 0], shape: new Uint8Array([1]) },
        target: { position: [1, 1] },
        type: 'connector',
      })
    );
  }),
  misfits('a text holding an embed', async (s) => {
    s.raw((doc) => {
      const text = new Y.Text();
      putElement(doc, 'a', { ...SHAPE, text });
      text.insertEmbed(0, { image: 'x' });
    });
  }),
  misfits('a text format holding a `__proto__` key', async (s) => {
    s.raw((doc) => {
      const text = new Y.Text();
      putElement(doc, 'a', { ...SHAPE, text });
      // A format's value is JSON in the update: the key stays an own key.
      text.insert(0, 'Mitosis', {
        reference: JSON.parse('{"pageId":"p","__proto__":{"x":1}}'),
      });
    });
  }),
  misfits('a `__proto__` key inside a plain value', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        ...SHAPE,
        shadow: JSON.parse(
          '{"blur":1,"color":"#000","offsetX":0,"offsetY":0,"__proto__":{"x":1}}'
        ),
      })
    );
  }),
  misfits('an element keyed `__proto__`', async (s) => {
    s.raw((doc) => putElement(doc, '__proto__', SHAPE));
  }),
  misfits('an element whose id is not its key', async (s) => {
    s.raw((doc) =>
      canvasOf(doc).set('a', mapOf({ ...SHAPE, id: 'b' }) as Y.Map<unknown>)
    );
  }),
  misfits('an element entry that is no map', async (s) => {
    s.raw((doc) => canvasOf(doc).set('a', 7 as unknown as Y.Map<unknown>));
  }),
  misfits('a group child that is not `true`', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        children: mapOf({ b: 1 }),
        title: new Y.Text(),
        type: 'group',
      })
    );
  }),
  misfits('a mind map node with no order', async (s) => {
    s.raw((doc) =>
      putElement(doc, 'a', {
        children: mapOf({ b: { parent: 'c' } }),
        layoutType: 0,
        style: 1,
        type: 'mindmap',
      })
    );
  }),
  misfits('a plane element no graph holds', async (s) => {
    await s.editor((tab) => {
      addPlane(tab.surface);
    });
    s.raw((doc) =>
      (elementIn(doc, 'plane').element.get('elements') as Y.Map<unknown>).set(
        'p',
        {
          element: { id: 'p', type: 'hologram' },
          order: 'a0',
        }
      )
    );
  }),
  misfits(
    'a plane element with a key no graph has, holding `undefined`',
    async (s) => {
      await s.editor((tab) => {
        addPlane(tab.surface);
      });
      s.raw((doc) =>
        (elementIn(doc, 'plane').element.get('elements') as Y.Map<unknown>).set(
          'p',
          { element: { ...point('p', 1), tilt: undefined }, order: 'a0' }
        )
      );
    }
  ),
  misfits('a keyed entry whose element is not its key', async (s) => {
    await s.editor((tab) => {
      addChart(tab.surface, 'bar');
    });
    s.raw((doc) =>
      (elementIn(doc, 'chart').element.get('bars') as Y.Map<unknown>).set('a', {
        element: bar('b'),
        order: 'a0',
      })
    );
  }),
  misfits('a block flavour the board does not hold', async (s) => {
    s.raw((doc) =>
      putBlock(doc, 'card', 'surface', {
        'prop:index': 'a1',
        'prop:xywh': '[0,0,10,10]',
        'sys:flavour': 'affine:embed-hologram',
      })
    );
  }),
  misfits(
    'a block under the wrong parent (a paragraph on the page)',
    async (s) => {
      s.raw((doc) =>
        putBlock(doc, 'loose', 'page', {
          'prop:text': new Y.Text('Loose'),
          'sys:flavour': 'affine:paragraph',
        })
      );
    }
  ),
  misfits('a picture whose kind and ref disagree', async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, {
        kind: 'emoji',
        label: '',
        ref: 'https://static.klipy.com/ii/a/b.webp',
      });
    });
  }),
  misfits('an emoji not in the list', async (s) => {
    await s.editor((tab) => {
      addCard(tab, PICTURE_FLAVOUR, { kind: 'emoji', label: '', ref: '1f4a9' });
    });
  }),
  misfits('a card missing its turn', async (s) => {
    s.raw((doc) =>
      putBlock(doc, 'pic', 'surface', {
        'prop:kind': 'emoji',
        'prop:label': '',
        'prop:ref': '1f9e0',
        'prop:xywh': '[0,0,96,96]',
        'sys:flavour': PICTURE_FLAVOUR,
      })
    );
  }),
  misfits("a block's children kept as a plain list", async (s) => {
    s.raw((doc) =>
      doc.getMap<Y.Map<unknown>>('blocks').set(
        'note',
        mapOf({
          'prop:xywh': '[0,0,10,10]',
          'sys:children': [],
          'sys:flavour': 'affine:note',
        }) as Y.Map<unknown>
      )
    );
  }),
  misfits('a block whose sys:id is not its key', async (s) => {
    s.raw((doc) =>
      putBlock(doc, 'note', 'page', {
        'prop:xywh': '[0,0,10,10]',
        'sys:flavour': 'affine:note',
        'sys:id': 'other',
      })
    );
  }),
  misfits('a note background map holding dark alone', async (s) => {
    s.raw((doc) =>
      putNote(doc, { 'prop:background': mapOf({ dark: '#000' }) })
    );
  }),
  misfits('a note background map with a key no colour has', async (s) => {
    s.raw((doc) =>
      putNote(doc, {
        'prop:background': mapOf({ dark: '#000', light: '#fff', tint: '#888' }),
      })
    );
  }),
  misfits("a note's border style BlockSuite has not", async (s) => {
    await s.editor(({ store }) => {
      addNote(store);
    });
    s.raw((doc) => {
      const { block } = blockIn(doc, 'affine:note');
      const edgeless = block.get('prop:edgeless') as Y.Map<Y.Map<unknown>>;
      edgeless.get('style')?.set('borderStyle', 'wavy');
    });
  }),
  misfits('a paragraph type BlockSuite has not', async (s) => {
    await s.editor(({ store }) => {
      store.addBlock(
        'affine:paragraph',
        { text: new Text('x') },
        addNote(store)
      );
    });
    s.raw((doc) =>
      blockIn(doc, 'affine:paragraph').block.set('prop:type', 'h7')
    );
  }),
  misfits("a page's title as a string", async (s) => {
    s.raw((doc) =>
      blockIn(doc, 'affine:page').block.set('prop:title', 'Board')
    );
  }),
];

/** BlockSuite's own enums, as the rules hold them. */
const values = (choices: Record<string, string>) => Object.values(choices);
const numbers = (choices: Record<string, string | number>) =>
  Object.values(choices).filter((value) => typeof value === 'number');
const sorted = (list: readonly (string | number)[]) =>
  [...list].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b))
  );
const BLOCKSUITE_ENUMS: Partial<
  Record<keyof typeof ENUMS, (string | number)[]>
> = {
  connectorMode: numbers(ConnectorMode),
  fontStyle: values(FontStyle),
  fontWeight: values(FontWeight),
  labelAnchor: values(ConnectorLabelOffsetAnchor),
  layoutType: numbers(LayoutType),
  mindmapStyle: numbers(MindmapStyle),
  noteDisplayMode: values(NoteDisplayMode),
  noteShadow: values(NoteShadow),
  pointStyle: values(PointStyle),
  shapeStyle: values(ShapeStyle),
  shapeType: values(ShapeType),
  strokeStyle: values(StrokeStyle),
  textAlign: values(TextAlign),
  textResizing: numbers(TextResizing),
  textVerticalAlign: values(TextVerticalAlign),
};

it("holds BlockSuite's own enums", () => {
  for (const [name, list] of Object.entries(BLOCKSUITE_ENUMS))
    expect(sorted(ENUMS[name as keyof typeof ENUMS]), name).toEqual(
      sorted(list)
    );
});

for (const each of CASES)
  it(`${each.fits ? 'fits' : 'misfits'} ${each.name}`, async () => {
    const results = verdicts(await updatesOf(each));
    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual([
      ...results.slice(0, -1).map(() => true),
      each.fits,
    ]);
  });
