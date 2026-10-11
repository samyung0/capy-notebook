import { hydrateStudy } from './hydrateStudy';
import { SharedQuiz } from './SharedQuiz';
import type { ShareState } from './state';

/** A shared quiz, without the flashcard code. */
export const hydrateQuiz = ({
  quiz,
  token,
}: Extract<ShareState, { kind: 'quizzes' }>) =>
  hydrateStudy(<SharedQuiz quiz={quiz} token={token} />);
