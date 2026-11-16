import { describe, expect, it } from 'vitest';
import type { PlotBlock } from '@/features/questions/types';
import { rebasePlot } from './rebase';

/* A plot dialog's draft rebased on a peer's change (Epo 2026-10-17): the
 * user's changes keep the user's value, the rest follows the peer. */

const plot: PlotBlock = {
  kind: 'line',
  series: [
    {
      name: 'A',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      name: 'B',
      points: [
        [0, 1],
        [1, 2],
      ],
    },
  ],
  title: 'Speed',
  type: 'plot',
  xTitle: 't',
  yTitle: 'v',
};

describe('rebasePlot', () => {
  it('keeps the user’s fields and follows the peer’s others', () => {
    const draft = { ...plot, title: 'Velocity' };
    const peer = { ...plot, kind: 'scatter' as const, xTitle: 'time' };
    expect(rebasePlot(plot, draft, peer)).toEqual({
      ...plot,
      kind: 'scatter',
      title: 'Velocity',
      xTitle: 'time',
    });
  });

  it('takes series by index, each series’ fields on their own', () => {
    const draft = {
      ...plot,
      series: [{ ...plot.series[0], name: 'Alpha' }, plot.series[1]],
    };
    const peer = {
      ...plot,
      series: [
        {
          ...plot.series[0],
          points: [
            [0, 0],
            [2, 2],
          ] as [number, number][],
        },
        plot.series[1],
        { name: 'C', points: [[5, 5]] as [number, number][] },
      ],
    };
    expect(rebasePlot(plot, draft, peer).series).toEqual([
      { ...peer.series[0], name: 'Alpha' },
      plot.series[1],
      peer.series[2],
    ]);
  });

  it('follows the peer entirely when the user changed nothing', () => {
    const peer = { ...plot, series: [plot.series[1]], title: 'Other' };
    expect(rebasePlot(plot, structuredClone(plot), peer)).toEqual(peer);
  });
});
