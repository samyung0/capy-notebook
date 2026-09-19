/* Markdown fence adapters for the universal Plate material document. */
import YAML from 'yaml';
import type { FlashcardContent, QuizBlock } from '@/features/materials/blocks';
import {
  type CustomMaterialElement,
  type FlashcardsElement,
  flashcardsElementToCards,
  MATERIAL_REF_TYPE,
  type MaterialRefElement,
  type MermaidElement,
  materialRefNode,
  mermaidNode,
  type QuizElement,
  quizElementToBlock,
} from '@/features/materials/document';

export const QUIZ_KEY = 'quiz';
export const FLASHCARDS_KEY = 'flashcards';
export const MERMAID_KEY = 'mermaid';
export const MATERIAL_REF_KEY = MATERIAL_REF_TYPE;

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
  | MermaidElement
  | MaterialRefElement;

/** Node for a fenced block. Quiz and flashcards fences become pending
 * references: a note keeps study blocks in their own material rows, created
 * by the editor once the node mounts. */
export function customBlockNode(
  type: CustomBlockLang,
  code: string
): CustomBlockElement {
  if (type === QUIZ_KEY || type === FLASHCARDS_KEY) {
    return materialRefNode('', type, code);
  }
  return mermaidNode(code);
}

export function customBlockCode(element: CustomMaterialElement): string {
  if (element.type === QUIZ_KEY)
    return quizFenceBody(quizElementToBlock(element));
  if (element.type === FLASHCARDS_KEY) {
    return flashcardsFenceBody(flashcardsElementToCards(element));
  }
  if (element.type === MERMAID_KEY) return element.source;
  if (element.type === MATERIAL_REF_KEY) return element.pending ?? '';
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
