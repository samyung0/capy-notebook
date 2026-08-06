import type { Question } from '@/api/types';

export type Answer =
  | number[]
  | boolean
  | string
  | string[]
  | Record<string, string>;

/** Normalize for comparison: lowercase, collapse whitespace, strip punctuation. */
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const setEq = (a: number[], b: number[]) =>
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Classic Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Fuzzy string match tolerant of typos. Similarity is 1 - distance/maxLen.
 * Very short answers (< 4 chars) must match exactly to avoid false positives.
 */
export function fuzzyMatch(a: string, b: string, threshold = 0.85): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen < 4) return x === y;
  return 1 - levenshtein(x, y) / maxLen >= threshold;
}

export function gradeQuestion(
  q: Question,
  answer: Answer | undefined
): boolean {
  if (answer == null) return false;
  switch (q.type) {
    case 'mcq':
    case 'multi':
      return (
        Array.isArray(answer) &&
        typeof answer[0] !== 'string' &&
        setEq(answer as number[], q.correct)
      );
    case 'boolean':
      return answer === q.correct;
    case 'fill':
    case 'short':
      return (
        typeof answer === 'string' &&
        q.accepted.some((a) => fuzzyMatch(a.value, answer))
      );
    case 'ordering':
      return (
        Array.isArray(answer) &&
        (answer as string[]).join('|') === q.items.map((i) => i.value).join('|')
      );
    case 'matching': {
      if (typeof answer !== 'object' || Array.isArray(answer)) return false;
      return q.pairs.every(
        (p) => (answer as Record<string, string>)[p.left] === p.right
      );
    }
    default:
      return false;
  }
}

export function emptyAnswer(q: Question): Answer {
  switch (q.type) {
    case 'mcq':
    case 'multi':
      return [];
    case 'boolean':
      return false;
    case 'fill':
    case 'short':
      return '';
    case 'ordering':
      return q.items.map((i) => i.value).sort(() => Math.random() - 0.5);
    case 'matching':
      return {};
    default:
      return '';
  }
}

/** The canonical answer used when a question is rendered as an answer key. */
export function answerKey(q: Question): Answer {
  switch (q.type) {
    case 'mcq':
    case 'multi':
      return q.correct;
    case 'boolean':
      return q.correct;
    case 'fill':
    case 'short':
      return q.accepted[0]?.value ?? '';
    case 'ordering':
      return q.items.map((item) => item.value);
    case 'matching':
      return Object.fromEntries(q.pairs.map((pair) => [pair.left, pair.right]));
    default:
      return '';
  }
}
