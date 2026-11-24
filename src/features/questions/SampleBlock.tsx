import { lazy, Suspense } from 'react';
import { TextView } from './TextView';
import type { QuestionPart } from './types';

// A drawn sample's preview loads only where one shows: shared pages render
// without it (Q3).
const DrawnSampleView = lazy(() =>
  import('@/features/quizzes/drawing/DrawnSample').then((module) => ({
    default: module.DrawnSampleView,
  }))
);

/** Whether a part has a sample answer: a long answer's written one or a
 * drawing part's drawn one. Both live in the part's answer, which marking
 * reads; every screen shows them in their own Sample answer section, after
 * the marking scheme (Epo 2026-11-15). */
export const hasSample = (part: QuestionPart) =>
  (part.answer.type === 'open' && !!part.answer.accepted[0]) ||
  (part.answer.type === 'canvas' && !!part.answer.sample);

/** A part's sample answer under its section's heading, or nothing. */
export function SampleView({
  className,
  part,
}: {
  className?: string;
  part: QuestionPart;
}) {
  const { answer } = part;
  if (answer.type === 'open' && answer.accepted[0])
    return <TextView className={className} text={answer.accepted[0]} />;
  if (answer.type === 'canvas' && answer.sample)
    return (
      <Suspense fallback={null}>
        <DrawnSampleView sample={answer.sample} />
      </Suspense>
    );
  return null;
}
