import { expect, it, vi } from 'vitest';
import type { FigureBlock } from '@/features/quizzes/liveFigures';
import { localFigureBinding } from './localFigureBinding';
import type { ChartBlock, GraphBlock } from './types';

const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
  elements: [
    { coords: [0, 0], id: 'A', type: 'point' },
    { coords: [1, 1], id: 'B', type: 'point' },
  ],
  height: 300,
  type: 'graph',
  width: 400,
};
const chart: ChartBlock = {
  kind: 'bar',
  labels: ['Mon', 'Tue'],
  series: [{ name: 'Rain', values: [1, null] }],
  title: 'Week',
  type: 'chart',
};

function held(block: FigureBlock) {
  const writes: [FigureBlock, FigureBlock][] = [];
  const remove = vi.fn();
  const binding = localFigureBinding(block, {
    remove,
    write: (next, previous) => writes.push([next, previous]),
  });
  return { binding, remove, writes };
}

it('hands each graph change to its holder with the block it replaced', () => {
  const { binding, writes } = held(graph);
  const heard = vi.fn();
  binding.subscribe(heard);
  binding.setElement({ coords: [2, 2], id: 'B', type: 'point' });
  binding.setElement({ coords: [3, 3], id: 'C', type: 'point' });
  binding.moveElement('C', 0);
  binding.deleteElement('A');
  binding.setBoard('grid', true);
  binding.setFields({ description: 'Points', width: 500 });
  expect(writes).toHaveLength(6);
  expect(writes[0][1]).toBe(graph);
  expect(writes[1][1]).toBe(writes[0][0]);
  expect(binding.read()?.block).toEqual({
    ...graph,
    board: { ...graph.board, grid: true },
    description: 'Points',
    elements: [
      { coords: [3, 3], id: 'C', type: 'point' },
      { coords: [2, 2], id: 'B', type: 'point' },
    ],
    width: 500,
  });
  expect(heard).toHaveBeenCalledTimes(6);
});

it('writes nothing for a change that leaves the figure as it is', () => {
  const { binding, writes } = held(graph);
  binding.setElement(graph.elements[0]);
  binding.setBoard('axis', true);
  expect(writes).toEqual([]);
});

it('edits a chart by place: rows, columns, names and cells', () => {
  const { binding } = held(chart);
  expect(binding.read()).toMatchObject({
    labels: ['l0', 'l1'],
    series: ['s0'],
  });
  const label = binding.addChartItem('labels', 2, 'Wed');
  const series = binding.addChartItem('series', 1, 'Sun');
  if (!(label && series)) throw new Error('not added');
  binding.setChartCell(series, label, 7);
  binding.setChartName('s0', 'Snow');
  binding.removeChartItem('labels', 'l0');
  expect(binding.read()?.block).toEqual({
    ...chart,
    labels: ['Tue', 'Wed'],
    series: [
      { name: 'Snow', values: [null, null] },
      { name: 'Sun', values: [null, 7] },
    ],
  });
});

it('reads as gone once removed and takes no more changes', () => {
  const { binding, remove, writes } = held(graph);
  binding.remove();
  expect(remove).toHaveBeenCalledWith(graph);
  expect(binding.read()).toBeNull();
  binding.setBoard('grid', true);
  expect(writes).toEqual([]);
});

it('takes its holder’s block changed elsewhere and tells its editor', () => {
  const { binding, writes } = held(graph);
  const heard = vi.fn();
  binding.subscribe(heard);
  const rebased = { ...graph, description: 'From a peer' };
  binding.receive(rebased);
  expect(binding.read()?.block).toBe(rebased);
  expect(heard).toHaveBeenCalledOnce();
  expect(writes).toEqual([]);
});
