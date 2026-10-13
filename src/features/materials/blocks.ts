/* ============================================================
   Custom fenced blocks — the markdown source-of-truth encoding for generated
   study materials. Quizzes and flashcards embed their structured payload in a
   fenced block whose language is the artifact kind:

     ```quiz
     questions: [ ... ]
     ```

     ```flashcards
     cards: [ ... ]
     ```

   The payload is YAML (JSON parses too). The fence bodies are read by the
   note editor's fence import (blocks/dialogContext.tsx) and the MSW mock, which
   derives the typed quiz and card views the UI expects; writing them is
   blocks/shared.ts's.
   ============================================================ */
import YAML from 'yaml';
import type { Question } from '@/api/types';
import { validateQuestions } from '@/features/questions/validation';

export interface QuizBlock {
  questions: Question[];
}
export interface FlashcardContent {
  back: string;
  front: string;
  id: string;
  /** Shown on the front under the text. */
  image?: { assetId: string };
}
export interface FlashcardsBlock {
  cards: FlashcardContent[];
}

/** Return the body of the first ```<lang> fenced block in content, or null. */
export function extractFence(content: string, lang: string): string | null {
  const lines = content.split('\n');
  const open = '```' + lang;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== open) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '```') return body.join('\n');
      body.push(lines[j]);
    }
    return body.join('\n'); // unterminated fence
  }
  return null;
}

function parseQuizYaml(body: string): QuizBlock {
  const doc: unknown = YAML.parse(body);
  if (!doc || typeof doc !== 'object' || !('questions' in doc))
    throw new Error('Quiz data needs a questions array.');
  return { questions: validateQuestions(doc.questions) };
}

function parseFlashcardsYaml(body: string): FlashcardsBlock {
  try {
    const doc = (YAML.parse(body) ?? {}) as { cards?: unknown };
    return {
      cards: Array.isArray(doc.cards) ? (doc.cards as FlashcardContent[]) : [],
    };
  } catch {
    return { cards: [] };
  }
}

export function parseQuizBlock(content: string): QuizBlock {
  const body = extractFence(content, 'quiz');
  if (body == null) return { questions: [] };
  return parseQuizYaml(body);
}

export function parseFlashcardsBlock(content: string): FlashcardsBlock {
  const body = extractFence(content, 'flashcards');
  if (body == null) return { cards: [] };
  return parseFlashcardsYaml(body);
}

/** Parse a raw ```quiz fence body (used by the Plate renderer). */
export function parseQuizFenceBody(body: string): QuizBlock {
  return parseQuizYaml(body);
}

/** Parse a raw ```flashcards fence body (used by the Plate renderer). */
export function parseFlashcardsFenceBody(body: string): FlashcardsBlock {
  return parseFlashcardsYaml(body);
}
