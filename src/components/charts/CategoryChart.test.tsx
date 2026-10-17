import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CategoryChart } from './CategoryChart';

it('renders all fifty categories with six series', () => {
  const labels = Array.from({ length: 50 }, (_, i) => `Category ${i + 1}`);
  const html = renderToStaticMarkup(
    <CategoryChart
      data={{
        kind: 'bar',
        labels,
        series: Array.from({ length: 6 }, (_, i) => ({
          name: `Series ${i}`,
          values: labels.map((_, j) => j - 20 + i),
        })),
        title: 'A large authored chart',
      }}
    />
  );
  expect(html).not.toContain('NaN');
  expect(html).toContain('Category 50');
});

it('draws nothing for an empty cell in every kind', () => {
  const marks = (kind: 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'stacked') =>
    renderToStaticMarkup(
      <CategoryChart
        data={{
          kind,
          labels: ['a', 'b', 'c'],
          series: [{ name: 'S', values: [2, null, 3] }],
          title: 'Gaps',
        }}
      />
    );
  for (const kind of [
    'bar',
    'hbar',
    'line',
    'area',
    'pie',
    'stacked',
  ] as const) {
    const html = marks(kind);
    expect(html, kind).not.toContain('NaN');
    expect(html, kind).not.toContain('b · S');
    expect(html, kind).not.toContain('b: ');
  }
  // A line breaks at the gap: two runs, one point each.
  expect(marks('line').match(/<polyline/g)).toHaveLength(2);
});

it('breaks a long word between letters and widens the tick column', () => {
  const html = renderToStaticMarkup(
    <CategoryChart
      data={{
        kind: 'bar',
        labels: [
          'Oxidativephosphorylationwithoutspaces',
          '細胞呼吸的氧化磷酸化階段',
        ],
        series: [{ name: 'S', values: [1_250_000, 2] }],
        title: 'Long labels',
      }}
    />
  );
  // The spaceless label takes two lines instead of one cut short.
  expect(html.match(/<tspan/g)).toHaveLength(3);
  expect(html).not.toContain('…');
  // "1,500,000" ends 4 units left of the plot, which starts past x = 36.
  const tick = html.match(/x="(\d+)"[^>]*>1,500,000</);
  expect(Number(tick?.[1])).toBeGreaterThan(36);
});
