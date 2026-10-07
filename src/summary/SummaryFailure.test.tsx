import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SummaryFailure } from './SummaryFailure';

it('uses the shared page error with manual retry only for loading failures', () => {
  const unavailable = renderToStaticMarkup(<SummaryFailure status={404} />);
  const failed = renderToStaticMarkup(<SummaryFailure status={503} />);
  expect(unavailable).toContain('data-error-surface="page"');
  expect(unavailable).toContain('Page not found');
  expect(unavailable).toContain(
    'The page may have moved or the address may be incorrect.'
  );
  expect(unavailable).not.toContain('Try again');
  expect(failed).toContain('data-error-surface="page"');
  expect(failed).toContain('Unable to load workspace');
  expect(failed).toContain('Try again');
});
