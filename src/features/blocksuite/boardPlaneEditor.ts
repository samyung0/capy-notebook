import type { GfxController } from '@blocksuite/affine/std/gfx';
import type { GraphElement, Vec } from '@/features/graph/model';
import type { PlaneOpener } from '@/features/graph/planeEditing';
import type {
  BoundFigure,
  FigureBinding,
} from '@/features/questions/figureBinding';
import { boardEditorSession } from './boardEditorShell';
import {
  fitCard,
  fitView,
  type PlaneElementModel,
  setPlaneEditor,
} from './boardPlane';
import { boardKindOf } from './boardTools';

const openers = new WeakMap<GfxController, PlaneOpener>();

/** Where this board's planes open: the page that mounted it shows the graph
 * editor (`GraphEditor`, the notes' and quizzes' own). */
export function setPlaneOpener(gfx: GfxController, open: PlaneOpener) {
  openers.set(gfx, open);
}

/**
 * The plane's elements and paper as a figure the graph editor edits (Epo
 * 2026-11-17: one editor everywhere): what one task writes is one undo step,
 * so a row typed, a point dragged or a construction erased with what stands on
 * it undoes at once. It has no size, view, title or description to set.
 */
function planeBinding(
  gfx: GfxController,
  model: PlaneElementModel,
  write: (change: () => void, join?: boolean) => void
): FigureBinding {
  let seen: { list: GraphElement[]; polar: boolean } | null = null;
  let figure: BoundFigure | null = null;
  /** The element a row being typed in last wrote. */
  let typed: string | null = null;
  const list = () => model.elementList;
  const writeList = (next: GraphElement[], join = false) =>
    write(() => model.writeList(next), join);
  /** A row typed into writes as it reads; its writes are one step, as the
   * plane's rows were written once on Enter or leaving (Epo 2026-11-13). */
  const typing = () => {
    const field = document.activeElement;
    return (
      field instanceof HTMLInputElement || field?.localName === 'math-field'
    );
  };
  const none = (what: string) => () => {
    throw new Error(`A canvas plane has no ${what}`);
  };
  return {
    addChartItem: none('chart'),
    deleteElement: (id) =>
      writeList(list().filter((element) => element.id !== id)),
    moveElement: (id, index) => {
      const element = list().find((each) => each.id === id);
      if (!element) return;
      const rest = list().filter((each) => each !== element);
      writeList([...rest.slice(0, index), element, ...rest.slice(index)]);
    },
    read: () => {
      if (!gfx.getElementById(model.id)) return null;
      const now = { list: list(), polar: model.polar };
      if (!figure || seen?.list !== now.list || seen.polar !== now.polar) {
        seen = now;
        const [, , width, height] = model.deserializedXYWH;
        figure = {
          block: {
            board: {
              axis: true,
              bbox: [
                model.x0,
                model.y0,
                model.x0 + width / model.ppu,
                model.y0 - height / model.ppu,
              ],
              grid: true,
              polar: now.polar,
            },
            elements: now.list,
            height,
            type: 'graph',
            width,
          },
          labels: [],
          series: [],
        };
      }
      return figure;
    },
    remove: none('removal'),
    removeChartItem: none('chart'),
    setBoard: (field, value) => {
      if (field !== 'polar') throw new Error(`A canvas plane has no ${field}`);
      write(() => {
        model.polar = Boolean(value);
      });
    },
    setChartCell: none('chart'),
    setChartName: none('chart'),
    setElement: (element) => {
      const now = list();
      const at = now.findIndex((each) => each.id === element.id);
      const join = typing() && typed === element.id;
      typed = typing() ? element.id : null;
      writeList(
        at < 0
          ? [...now, element]
          : now.map((each, i) => (i === at ? element : each)),
        join
      );
    },
    setFields: none('fields'),
    subscribe: (listener) => {
      const updates = gfx.surface?.elementUpdated.subscribe(({ id }) => {
        if (id === model.id) listener();
      });
      const removed = gfx.surface?.elementRemoved.subscribe(({ id }) => {
        if (id === model.id) listener();
      });
      return () => {
        updates?.unsubscribe();
        removed?.unsubscribe();
      };
    },
  };
}

/** Opens a plane card in the page's graph editor. Leaving writes the camera
 * outside the undo history, as where the student looks, and a card that fits
 * its marks takes their size. */
function openPlaneEditor(gfx: GfxController, model: PlaneElementModel) {
  const open = openers.get(gfx);
  if (!open) throw new Error('This board has no page to edit its planes on');
  let dismiss = () => undefined as void;
  // The page's editor goes here, over the board, as the plane's always did;
  // its keys stop on their way out to the board's shortcuts.
  const root = document.createElement('div');
  root.className = 'capy-graph-editor';
  root.addEventListener('keydown', (event) => event.stopPropagation());
  const session = boardEditorSession(
    gfx,
    model.id,
    () => root.remove(),
    () => dismiss()
  );
  if (!session) return;
  session.board.append(root);
  const [, , width, height] = model.deserializedXYWH;
  let closed = false;
  dismiss = open({
    binding: planeBinding(gfx, model, session.write),
    camera: {
      centre: [
        model.x0 + width / 2 / model.ppu,
        model.y0 - height / 2 / model.ppu,
      ],
      ppu: model.ppu,
    },
    close: ({ centre: [x, y], ppu }: { centre: Vec; ppu: number }) => {
      if (closed) return;
      closed = true;
      if (!gfx.getElementById(model.id)) {
        session.close();
        return;
      }
      const [, , w, h] = model.deserializedXYWH;
      gfx.doc.withoutTransact(() => {
        model.ppu = ppu;
        model.x0 = x - w / 2 / ppu;
        model.y0 = y + h / 2 / ppu;
      });
      // Fit to size sizes the card; Custom size frames the plane in it.
      if (model.fit) fitCard(model);
      else fitView(model);
      session.close();
    },
    history: session.history,
    list: boardKindOf(gfx.std) === 'workspace',
    root,
  });
}

setPlaneEditor(openPlaneEditor);
