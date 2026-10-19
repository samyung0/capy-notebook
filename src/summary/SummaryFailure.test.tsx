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
  // An unreadable shared note, quiz or set (422) is named by its kind;
  // retrying it never helps.
  for (const [kind, title] of [
    ['notes', 'This note could not be loaded'],
    ['quizzes', 'This quiz could not be loaded'],
    ['flashcards', 'This flashcard set could not be loaded'],
  ] as const) {
    const unreadable = renderToStaticMarkup(
      <SummaryFailure kind={kind} status={422} />
    );
    expect(unreadable).toContain(title);
    expect(unreadable).not.toContain('Try again');
  }
});
