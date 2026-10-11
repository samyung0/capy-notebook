import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlotChart } from './PlotChart';

const POLYLINE_POINTS = /points="([^"]+)"/;

it('draws curves in x order with clean ticks, a dashed reference line and labelled points', () => {
  const html = renderToStaticMarkup(
    <PlotChart
      data={{
        lines: [{ axis: 'y', label: 'threshold −55 mV', value: -55 }],
        marks: [{ label: 'Na⁺ floods in', x: 1.2, y: -10 }],
        series: [
          {
            name: 'Vm',
            points: [
              [3, -80],
              [0, -70],
              [1.5, 30],
            ],
          },
        ],
        title: 'Action potential',
        xTitle: 'Time (ms)',
        yTitle: 'Membrane potential (mV)',
      }}
    />
  );
  expect(html).not.toContain('NaN');
  expect(html).toContain('stroke-dasharray="4 3"');
  for (const text of ['threshold −55 mV', 'Na⁺ floods in', 'Time (ms)'])
    expect(html).toContain(text);
  // y ticks every 50 from -100 to 50, x ticks every 1 from 0 to 3.
  for (const tick of ['>-100<', '>-50<', '>0<', '>50<', '>3<'])
    expect(html).toContain(tick);
  const points = html.match(POLYLINE_POINTS)?.[1].split(' ') ?? [];
  const xs = points.map((point) => Number(point.split(',')[0]));
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
});
