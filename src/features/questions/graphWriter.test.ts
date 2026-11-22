import { expect, it, vi } from 'vitest';
import { QUESTION_GRAPH_ELEMENTS_MAX } from '@/api/limits.generated';
import { m } from '@/i18n';
import type { FigureBinding } from './figureBinding';
import { graphFull } from './graph';
import { type Frames, graphWriter } from './graphWriter';
import { localFigureBinding } from './localFigureBinding';
import type { GraphBlock, GraphElement } from './types';

const point = (id: string, x: number): GraphElement => ({
  coords: [x, 0],
  id,
  type: 'point',
});
const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
  elements: [point('A', 0), point('B', 1)],
  height: 300,
  type: 'graph',
  width: 400,
};

/** A writer over a draft graph, its frames run by hand, counting writes. */
function setup(start: GraphElement[]) {
  const binding = localFigureBinding(
    { ...graph, elements: start },
    {
      remove: () => {},
      write: () => {},
    }
  );
  const calls = vi.fn();
  let watching = 0;
  const counted: FigureBinding = {
    ...binding,
    deleteElement: (id) => {
      calls('delete', id);
      binding.deleteElement(id);
    },
    moveElement: (id, index) => {
      calls('move', id, index);
      binding.moveElement(id, index);
    },
    setElement: (element) => {
      calls('set', element.id);
      binding.setElement(element);
    },
    subscribe: (listener) => {
      watching++;
      const off = binding.subscribe(listener);
      return () => {
        watching--;
        off();
      };
    },
  };
  let queued: (() => void) | null = null;
  const frames: Frames = {
    cancel: () => {
      queued = null;
    },
    request: (run) => {
      queued = run;
      return 1;
    },
  };
  // The rows' keys are their elements' unless a test has rows that do not draw.
  const local: { elements: GraphElement[]; keys?: string[] } = {
    elements: start,
  };
  const refused = vi.fn();
  const writer = graphWriter(
    counted,
    () => ({
      elements: local.elements,
      keys: local.keys ?? local.elements.map((element) => element.id),
    }),
    refused,
    frames
  );
  const frame = () => {
    const run = queued;
    queued = null;
    run?.();
  };
  const elements = () => {
    const block = binding.read()?.block;
    return block?.type === 'graph' ? block.elements : [];
  };
  return {
    binding,
    calls,
    elements,
    frame,
    local,
    /** Whether a frame waits to write. */
    queued: () => queued !== null,
    refused,
    /** How many watches the writer holds on the figure. */
    watching: () => watching,
    writer,
  };
}

/** A quiz graph at the cap whose row R, typed as its 100th, a co-editor's add
 * took the place of: R is refused and the writer watches the figure. */
function refusedAtCap() {
  const start = Array.from(
    { length: QUESTION_GRAPH_ELEMENTS_MAX - 1 },
    (_, i) => point(`P${i}`, i)
  );
  const t = setup(start);
  t.binding.setElement(point('peer', 50));
  t.local.keys = [...start.map(({ id }) => id), 'peer', 'R'];
  t.local.elements = [...start, point('peer', 50), point('R', -1)];
  t.writer.touch(['R']);
  t.frame();
  return t;
}

it('writes a row typed many times in one frame once, with its last value', () => {
  const { calls, elements, frame, local, writer } = setup(graph.elements);
  for (const x of [2, 3, 4]) {
    local.elements = [point('A', 0), point('B', x)];
    writer.touch(['B']);
  }
  expect(calls).not.toHaveBeenCalled();
  frame();
  expect(calls.mock.calls).toEqual([['set', 'B']]);
  expect(elements()).toEqual([point('A', 0), point('B', 4)]);
  expect(writer.typing('B')).toBe(false);
});

it('writes nothing when a touched row holds what the figure has', () => {
  const { calls, frame, writer } = setup(graph.elements);
  writer.touch(['A', 'B']);
  frame();
  expect(calls).not.toHaveBeenCalled();
});

it('keeps a row that gives no element unwritten and typing until it does', () => {
  const { calls, elements, frame, local, writer } = setup(graph.elements);
  // Row C is typed but does not parse yet: no element for it.
  writer.touch(['C']);
  frame();
  expect(calls).not.toHaveBeenCalled();
  expect(writer.typing('C')).toBe(true);
  // Now it draws, between A and B: it goes in at its row's place.
  local.elements = [point('A', 0), point('C', 5), point('B', 1)];
  writer.touch(['C']);
  frame();
  expect(calls.mock.calls).toEqual([
    ['set', 'C'],
    ['move', 'C', 1],
  ]);
  expect(elements()).toEqual(local.elements);
  expect(writer.typing('C')).toBe(false);
});

it('puts a new row after a row that cannot draw but keeps its element', () => {
  const { calls, elements, frame, local, writer } = setup(graph.elements);
  // B's row no longer draws (typed into), and Q is added under it.
  local.keys = ['A', 'B', 'Q'];
  local.elements = [point('A', 0), point('Q', 3)];
  writer.touch(['B', 'Q']);
  frame();
  expect(calls.mock.calls).toEqual([['set', 'Q']]);
  expect(elements().map(({ id }) => id)).toEqual(['A', 'B', 'Q']);
});

it('names an element the graph check refuses and does not write it', () => {
  const { calls, frame, local, refused, writer } = setup(graph.elements);
  local.elements = [
    ...graph.elements,
    { coords: [0, 0], id: 'T', text: 'x'.repeat(10_000), type: 'text' },
  ];
  writer.touch(['T']);
  frame();
  expect(calls).not.toHaveBeenCalled();
  expect([...refused.mock.calls[0][0].keys()]).toEqual(['T']);
  expect(writer.typing('T')).toBe(true);
});

it('writes what waits for its frame when the dialog closes', () => {
  const { elements, local, writer } = setup(graph.elements);
  local.elements = [point('A', 9), point('B', 1)];
  writer.touch(['A']);
  writer.flush();
  expect(elements()).toEqual(local.elements);
});

it('on a graph two adds merged past the cap, row 101 edits and saves, and adding a row does nothing', () => {
  const many = Array.from({ length: QUESTION_GRAPH_ELEMENTS_MAX + 1 }, (_, i) =>
    point(`P${i}`, i)
  );
  // Every surface writes every row (Epo 2026-11-22).
  const { calls, elements, frame, local, refused, writer } = setup(many);
  local.elements = many.map((one) =>
    one.id === 'P100' ? point('P100', -3) : one
  );
  writer.touch(['P100']);
  frame();
  expect(calls.mock.calls).toEqual([['set', 'P100']]);
  expect(elements()[100]).toEqual(point('P100', -3));
  // The editor offers no new row and its tools add none: it is full; a new
  // row that reaches the writer anyway is not written.
  expect(graphFull(elements().length)).toBe(true);
  local.elements = [...local.elements, point('N', -4)];
  writer.touch(['N']);
  frame();
  expect(calls).not.toHaveBeenCalledWith('set', 'N');
  expect(elements()).toHaveLength(QUESTION_GRAPH_ELEMENTS_MAX + 1);
  expect(refused).toHaveBeenLastCalledWith(
    new Map([
      [
        'N',
        m.question_ui_graph_elements_max({ max: QUESTION_GRAPH_ELEMENTS_MAX }),
      ],
    ])
  );
});

it('a row started under the cap waits once a co-editor fills the last place, keeping its text', () => {
  const start = Array.from(
    { length: QUESTION_GRAPH_ELEMENTS_MAX - 1 },
    (_, i) => point(`P${i}`, i)
  );
  const { binding, calls, elements, frame, local, refused, writer } =
    setup(start);
  // The 100th row is typed ("y=", no element yet) as a co-editor adds the
  // 100th element; then the row draws.
  local.keys = [...start.map(({ id }) => id), 'R'];
  writer.touch(['R']);
  frame();
  binding.setElement(point('peer', 50));
  local.keys = [...local.keys, 'peer'];
  local.elements = [...start, point('R', -1), point('peer', 50)];
  writer.touch(['R']);
  frame();
  expect(elements()).toHaveLength(QUESTION_GRAPH_ELEMENTS_MAX);
  expect(calls).not.toHaveBeenCalledWith('set', 'R');
  expect(refused).toHaveBeenLastCalledWith(
    new Map([
      [
        'R',
        m.question_ui_graph_elements_max({
          max: QUESTION_GRAPH_ELEMENTS_MAX,
        }),
      ],
    ])
  );
  expect(writer.typing('R')).toBe(true);
  // A co-editor's delete makes room: R goes in on its own, on the next frame.
  binding.deleteElement('P0');
  local.keys = local.keys.slice(1);
  local.elements = local.elements.slice(1);
  frame();
  expect(elements().map(({ id }) => id)).toContain('R');
  expect(elements()).toHaveLength(QUESTION_GRAPH_ELEMENTS_MAX);
  expect(refused).toHaveBeenLastCalledWith(new Map());
});

it("a row refused at the cap leaves a co-editor's 100th element editable", () => {
  const start = Array.from(
    { length: QUESTION_GRAPH_ELEMENTS_MAX - 1 },
    (_, i) => point(`P${i}`, i)
  );
  const { binding, elements, frame, local, writer } = setup(start);
  // R is typed last, a co-editor adds the 100th element below it, R is
  // refused: readers draw the co-editor's element, the figure's 100th.
  local.keys = [...start.map(({ id }) => id), 'R'];
  writer.touch(['R']);
  frame();
  binding.setElement(point('peer', 50));
  local.keys = [...local.keys, 'peer'];
  local.elements = [...start, point('R', -1), point('peer', 50)];
  writer.touch(['R']);
  frame();
  expect(elements().map(({ id }) => id)).not.toContain('R');
  local.elements = [...start, point('R', -1), point('peer', 4)];
  writer.touch(['peer']);
  frame();
  expect(elements().find(({ id }) => id === 'peer')).toEqual(point('peer', 4));
});

it('closing leaves no frame and no watch, so a row still refused never reaches the room', () => {
  const t = refusedAtCap();
  expect(t.watching()).toBe(1);
  // Closing: what waits is written (a point moved by the stage's last
  // commit), then the writer is disposed.
  t.local.elements = t.local.elements.map((one) =>
    one.id === 'P5' ? point('P5', 42) : one
  );
  t.writer.touch(['P5']);
  t.writer.flush();
  // A co-editor's change lands just before the writer is disposed.
  t.binding.setElement(point('peer', 51));
  expect(t.queued()).toBe(true);
  t.writer.dispose();
  expect(t.queued()).toBe(false);
  expect(t.watching()).toBe(0);
  // A co-editor's later delete makes room: R stays out.
  t.binding.deleteElement('P0');
  t.frame();
  expect(t.elements().map(({ id }) => id)).not.toContain('R');
  expect(t.watching()).toBe(0);
});

it('a row refused, then typed back to what the figure holds, is refused no more', () => {
  const text: GraphElement = {
    coords: [0, 0],
    id: 'T',
    text: 'ok',
    type: 'text',
  };
  const t = setup([text]);
  t.local.elements = [{ ...text, text: 'x'.repeat(10_000) }];
  t.writer.touch(['T']);
  t.frame();
  expect(t.refused).toHaveBeenLastCalledWith(
    new Map([['T', expect.any(String)]])
  );
  expect(t.watching()).toBe(1);
  t.local.elements = [text];
  t.writer.touch(['T']);
  t.frame();
  expect(t.refused).toHaveBeenLastCalledWith(new Map());
  expect(t.writer.typing('T')).toBe(false);
  expect(t.watching()).toBe(0);
});

it("while a row is refused, co-editors' changes write once a frame and tell nothing new, and its own write queues none", () => {
  const t = refusedAtCap();
  const told = t.refused.mock.calls.length;
  for (const x of [60, 61, 62]) t.binding.setElement(point('peer', x));
  t.frame();
  expect(t.queued()).toBe(false);
  expect(t.refused.mock.calls.length).toBe(told);
  // Room opens; R's own write queues no further frame.
  t.binding.deleteElement('P0');
  t.local.keys = t.local.keys?.slice(1);
  t.local.elements = t.local.elements.slice(1);
  t.frame();
  expect(t.elements().map(({ id }) => id)).toContain('R');
  expect(t.queued()).toBe(false);
});
