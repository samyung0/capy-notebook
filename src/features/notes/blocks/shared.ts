/* Markdown fence adapters for the universal Plate material document. */
import YAML from 'yaml';
import type { FlashcardContent, QuizBlock } from '@/features/materials/blocks';
import {
  type CustomMaterialElement,
  type FlashcardsElement,
  flashcardsElementToCards,
  flashcardsNodeFromFence,
  type MermaidElement,
  mermaidNode,
  type QuizElement,
  quizElementToBlock,
  quizNodeFromFence,
} from '@/features/materials/document';

export const QUIZ_KEY = 'quiz';
export const FLASHCARDS_KEY = 'flashcards';
export const MERMAID_KEY = 'mermaid';

export const CUSTOM_BLOCK_LANGS = [
  QUIZ_KEY,
  FLASHCARDS_KEY,
  MERMAID_KEY,
] as const;
export type CustomBlockLang = (typeof CUSTOM_BLOCK_LANGS)[number];

export function isCustomBlockLang(lang: unknown): lang is CustomBlockLang {
  return (
    typeof lang === 'string' &&
    (CUSTOM_BLOCK_LANGS as readonly string[]).includes(lang)
  );
}

export type CustomBlockElement =
  | QuizElement
  | FlashcardsElement
  | MermaidElement;

export function customBlockNode(
  type: CustomBlockLang,
  code: string
): CustomBlockElement {
  if (type === QUIZ_KEY) return quizNodeFromFence(code);
  if (type === FLASHCARDS_KEY) return flashcardsNodeFromFence(code);
  return mermaidNode(code);
}

export function customBlockCode(element: CustomMaterialElement): string {
  if (element.type === QUIZ_KEY)
    return quizFenceBody(quizElementToBlock(element));
  if (element.type === FLASHCARDS_KEY) {
    return flashcardsFenceBody(flashcardsElementToCards(element));
  }
  if (element.type === MERMAID_KEY) return element.source;
  return '';
}

/** Serialize quiz form data to a ```quiz fence body (YAML). */
export function quizFenceBody(data: QuizBlock): string {
  const payload: Record<string, unknown> = { questions: data.questions ?? [] };
  if (data.timeLimitMin != null) payload.timeLimitMin = data.timeLimitMin;
  return YAML.stringify(payload);
}

/** Serialize flashcards to a ```flashcards fence body (YAML). */
export function flashcardsFenceBody(cards: FlashcardContent[]): string {
  return YAML.stringify({ cards: cards ?? [] });
}
