import { describe, expect, it } from 'vitest';
import { rebaseBlock } from './rebase';

/* A figure dialog's draft rebased on a peer's change (Epo 2026-10-17): the
 * user's changes keep the user's value, the rest follows the peer. */

const chart = {
  kind: 'bar',
  labels: ['Jan', 'Feb'],
  series: [
    { name: 'A', values: [1, 2] },
    { name: 'B', values: [3, 4] },
  ],
  title: 'Sales',
  type: 'chart',
};

const point = (id: string, x: number) => ({
  coords: [x, 0],
  id,
  type: 'point',
});
const graph = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
  elements: [
    point('p1', 0),
    point('p2', 1),
    { id: 's1', points: ['p1', 'p2'], type: 'segment' },
  ],
  height: 300,
  image: { svg: '<svg/>' },
  type: 'graph',
  width: 400,
};

describe('rebaseBlock', () => {
  it('keeps the user’s fields and follows the peer’s others', () => {
    const draft = { ...chart, title: 'Revenue' };
    const peer = { ...chart, kind: 'line', xTitle: 'Month' };
    expect(rebaseBlock(chart, draft, peer)).toEqual({
      ...chart,
      kind: 'line',
      title: 'Revenue',
      xTitle: 'Month',
    });
  });

  it('takes series by index, each series’ fields on their own', () => {
    const draft = {
      ...chart,
      series: [{ name: 'A', values: [10, 20] }, chart.series[1]],
    };
    const peer = {
      ...chart,
      series: [
        { name: 'Alpha', values: [1, 2] },
        { name: 'B', values: [3, 40] },
        { name: 'C', values: [5, 6] },
      ],
    };
    expect(rebaseBlock(chart, draft, peer).series).toEqual([
      { name: 'Alpha', values: [10, 20] },
      { name: 'B', values: [3, 40] },
      { name: 'C', values: [5, 6] },
    ]);
  });

  it('keeps a series the user removed removed', () => {
    const draft = { ...chart, series: [chart.series[0]] };
    const peer = {
      ...chart,
      series: [chart.series[0], { name: 'B', values: [9, 9] }],
    };
    expect(rebaseBlock(chart, draft, peer).series).toEqual([chart.series[0]]);
  });

  it('takes graph elements by id: edits, the peer’s removals and both sides’ additions', () => {
    const draft = {
      ...graph,
      elements: [
        point('p1', 5),
        graph.elements[1],
        graph.elements[2],
        point('p9', 9),
      ],
    };
    const peer = {
      ...graph,
      elements: [point('p1', 0), point('p2', 1), point('p3', 3)],
    };
    expect(rebaseBlock(graph, draft, peer).elements).toEqual([
      point('p1', 5),
      point('p2', 1),
      point('p9', 9),
      point('p3', 3),
    ]);
  });

  it('keeps an element the user changed when the peer removed it', () => {
    const draft = {
      ...graph,
      elements: [graph.elements[0], point('p2', 7), graph.elements[2]],
    };
    const peer = { ...graph, elements: [graph.elements[0]] };
    expect(rebaseBlock(graph, draft, peer).elements).toEqual([
      graph.elements[0],
      point('p2', 7),
    ]);
  });

  it('follows the peer entirely when the user changed nothing', () => {
    const peer = {
      ...chart,
      labels: ['Q1'],
      series: [{ name: 'A', values: [1] }],
    };
    expect(rebaseBlock(chart, structuredClone(chart), peer)).toEqual(peer);
  });
});
