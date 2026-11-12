import type { LearnerQuestion } from '@/features/questions/types';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
  type MaterialDocument,
  type QuizElement,
} from './document';

/** A set's cards as its read stored them. */
export const storedCards = (content: MaterialDocument) =>
  flashcardsElementToCards(
    content.value.find(
      (node): node is FlashcardsElement => node.type === 'flashcards'
    ) ?? { children: [], id: '', type: 'flashcards' }
  );

/** A quiz's questions as its read stored them: no answer key. */
export const storedQuestions = (content: MaterialDocument) => {
  const quiz = content.value.find(
    (node): node is QuizElement => node.type === 'quiz'
  );
  return (quiz?.children ?? []).flatMap((node) =>
    'type' in node && node.type === 'quiz_question'
      ? [node.question as unknown as LearnerQuestion]
      : []
  );
};
