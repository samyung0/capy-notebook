import { hydrateStudy } from './hydrateStudy';
import { SharedFlashcards } from './SharedFlashcards';
import type { ShareState } from './state';

/** A shared flashcard set, without the quiz code. */
export const hydrateFlashcards = ({
  set,
  token,
}: Extract<ShareState, { kind: 'flashcards' }>) =>
  hydrateStudy(<SharedFlashcards set={set} token={token} />);
