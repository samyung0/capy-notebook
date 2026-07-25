/* ============================================================
   Custom fenced blocks — the markdown source-of-truth encoding for generated
   study materials. Quizzes and flashcards embed their structured payload in a
   fenced block whose language is the artifact kind:

     ```quiz
     questions: [ ... ]
     timeLimitMin: 20
     ```

     ```flashcards
     cards: [ ... ]
     ```

   The payload is YAML. JSON is a subset of YAML, so blocks backfilled from the
   legacy JSON tables parse identically; we re-emit clean YAML on every write.
   Shared by the read-only Plate renderer and the MSW mock (which derives the
   typed Quiz/Deck/Flashcard views the existing UI expects).
   ============================================================ */
import YAML from 'yaml';
import type { Question } from '@/api/types';

export interface QuizBlock {
  questions: Question[];
  timeLimitMin?: number;
}
export interface FlashcardContent {
  back: string;
  front: string;
  id: string;
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
  try {
    const doc = (YAML.parse(body) ?? {}) as {
      questions?: unknown;
      timeLimitMin?: unknown;
    };
    return {
      questions: Array.isArray(doc.questions)
        ? (doc.questions as Question[])
        : [],
      timeLimitMin:
        typeof doc.timeLimitMin === 'number' ? doc.timeLimitMin : undefined,
    };
  } catch {
    return { questions: [] };
  }
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

function fenceDoc(title: string, lang: string, payload: unknown): string {
  const body = YAML.stringify(payload); // trailing newline included
  return `# ${title}\n\n\`\`\`${lang}\n${body}\`\`\`\n`;
}

export function quizMarkdown(title: string, data: QuizBlock): string {
  const payload: Record<string, unknown> = { questions: data.questions ?? [] };
  if (data.timeLimitMin != null) payload.timeLimitMin = data.timeLimitMin;
  return fenceDoc(title || 'Quiz', 'quiz', payload);
}

export function flashcardsMarkdown(
  title: string,
  cards: FlashcardContent[]
): string {
  return fenceDoc(title || 'Flashcards', 'flashcards', { cards: cards ?? [] });
}
