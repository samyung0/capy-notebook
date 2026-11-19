import { expect, it, vi } from 'vitest';
import type { FigureBinding } from './figureBinding';
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
  const binding = localFigureBinding(graph, {
    remove: () => {},
    write: () => {},
  });
  const calls = vi.fn();
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
  return { calls, elements, frame, local, refused, writer };
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
