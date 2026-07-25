import { createPlatePlugin } from 'platejs/react';
import {
  FlashcardBackElement,
  FlashcardElement,
  FlashcardFrontElement,
  FlashcardsElement,
  MermaidCaptionElement,
  MermaidElement,
  QuizElement,
  QuizExplanationElement,
  QuizOptionElement,
  QuizPromptElement,
  QuizQuestionElement,
} from './elements';
import { FLASHCARDS_KEY, MERMAID_KEY, QUIZ_KEY } from './shared';

export const QuizElementPlugin = createPlatePlugin({
  key: QUIZ_KEY,
  node: { isElement: true, type: QUIZ_KEY },
}).withComponent(QuizElement);

export const QuizQuestionPlugin = createPlatePlugin({
  key: 'quiz_question',
  node: { isElement: true, type: 'quiz_question' },
}).withComponent(QuizQuestionElement);

export const QuizPromptPlugin = createPlatePlugin({
  key: 'quiz_prompt',
  node: { isElement: true, type: 'quiz_prompt' },
}).withComponent(QuizPromptElement);

export const QuizOptionPlugin = createPlatePlugin({
  key: 'quiz_option',
  node: { isElement: true, type: 'quiz_option' },
}).withComponent(QuizOptionElement);

export const QuizExplanationPlugin = createPlatePlugin({
  key: 'quiz_explanation',
  node: { isElement: true, type: 'quiz_explanation' },
}).withComponent(QuizExplanationElement);

export const FlashcardsElementPlugin = createPlatePlugin({
  key: FLASHCARDS_KEY,
  node: { isElement: true, type: FLASHCARDS_KEY },
}).withComponent(FlashcardsElement);

export const FlashcardPlugin = createPlatePlugin({
  key: 'flashcard',
  node: { isElement: true, type: 'flashcard' },
}).withComponent(FlashcardElement);

export const FlashcardFrontPlugin = createPlatePlugin({
  key: 'flashcard_front',
  node: { isElement: true, type: 'flashcard_front' },
}).withComponent(FlashcardFrontElement);

export const FlashcardBackPlugin = createPlatePlugin({
  key: 'flashcard_back',
  node: { isElement: true, type: 'flashcard_back' },
}).withComponent(FlashcardBackElement);

export const MermaidElementPlugin = createPlatePlugin({
  key: MERMAID_KEY,
  node: { isElement: true, type: MERMAID_KEY },
}).withComponent(MermaidElement);

export const MermaidCaptionPlugin = createPlatePlugin({
  key: 'mermaid_caption',
  node: { isElement: true, type: 'mermaid_caption' },
}).withComponent(MermaidCaptionElement);

export const customBlockPlugins = [
  QuizElementPlugin,
  QuizQuestionPlugin,
  QuizPromptPlugin,
  QuizOptionPlugin,
  QuizExplanationPlugin,
  FlashcardsElementPlugin,
  FlashcardPlugin,
  FlashcardFrontPlugin,
  FlashcardBackPlugin,
  MermaidElementPlugin,
  MermaidCaptionPlugin,
];
