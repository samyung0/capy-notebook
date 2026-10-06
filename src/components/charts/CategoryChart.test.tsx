import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CategoryChart } from './CategoryChart';

it('renders all fifty categories with eight series', () => {
  const labels = Array.from({ length: 50 }, (_, i) => `Category ${i + 1}`);
  const html = renderToStaticMarkup(
    <CategoryChart
      data={{
        kind: 'bar',
        labels,
        series: Array.from({ length: 8 }, (_, i) => ({
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
