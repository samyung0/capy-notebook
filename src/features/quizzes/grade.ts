import type { Question, QuestionPart } from '@/api/types';
import { partMarks, questionMarks } from '@/features/questions/types';
import { quantityValuePattern } from '@/features/questions/validation';

export type Answer =
  | number[]
  | boolean
  | string
  | Record<string, number>
  | null;
export type Answers = Record<string, Answer>;
export type QuestionScore = { awarded: number; max: number };
const numericOrSymbolic = /[\d+\-*/^=<>]/;
const norm = (value: string) =>
  value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1])
      );
    previous = current;
  }
  return previous[b.length];
}
export function fuzzyMatch(a: string, b: string, threshold = 0.85): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Numeric and symbolic answers cannot lose signs, decimal points or operators.
  if (numericOrSymbolic.test(x + y)) return false;
  const length = Math.max(x.length, y.length);
  return (
    length >= 4 && length <= 1000 && 1 - levenshtein(x, y) / length >= threshold
  );
}
type Quantity = { numerator: bigint; denominator: bigint; exponent: bigint };

// Keep decimal exponents separate: neither precision nor magnitude relies on floats.
function decimal(value: string): { coefficient: bigint; exponent: bigint } {
  const [mantissa, exponent = '0'] = value.trim().toLowerCase().split('e');
  const dot = mantissa.indexOf('.');
  return {
    coefficient: BigInt(mantissa.replace('.', '')),
    exponent:
      BigInt(exponent) - BigInt(dot < 0 ? 0 : mantissa.length - dot - 1),
  };
}

export function quantityValue(value: string): Quantity | undefined {
  const input = value.trim();
  if (!quantityValuePattern.test(input)) return;
  const [numerator, denominator = '1'] = input.split('/');
  const n = decimal(numerator);
  const d = decimal(denominator);
  if (d.coefficient === 0n) return;
  return {
    denominator: d.coefficient,
    exponent: n.exponent - d.exponent,
    numerator: n.coefficient,
  };
}

function sameQuantity(a: Quantity, b: Quantity): boolean {
  const normalize = (input: bigint, power: bigint) => {
    let coefficient = input;
    let exponent = power;
    if (coefficient === 0n) return { coefficient, exponent: 0n };
    while (coefficient % 10n === 0n) {
      coefficient /= 10n;
      exponent += 1n;
    }
    return { coefficient, exponent };
  };
  const left = normalize(a.numerator * b.denominator, a.exponent);
  const right = normalize(b.numerator * a.denominator, b.exponent);
  return (
    left.coefficient === right.coefficient && left.exponent === right.exponent
  );
}
export const questionPoints = questionMarks;
export const formatPoints = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);
function closedCorrect(part: QuestionPart, value: Answer | undefined): boolean {
  const answer = part.answer;
  if (value == null) return false;
  switch (answer.type) {
    case 'mcq':
    case 'multi':
      return (
        Array.isArray(value) &&
        new Set(value).size === value.length &&
        value.length === answer.correct.length &&
        value.every((i) => answer.correct.includes(i))
      );
    case 'boolean':
      return value === answer.correct;
    case 'short': {
      if (typeof value !== 'string') return false;
      if (answer.unit) {
        const numeric = quantityValue(value);
        return (
          numeric !== undefined &&
          answer.accepted.some((expected) => {
            const accepted = quantityValue(expected);
            return accepted !== undefined && sameQuantity(accepted, numeric);
          })
        );
      }
      return answer.accepted.some((expected) => fuzzyMatch(expected, value));
    }
    case 'matching':
      return (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        answer.pairs.every((pair, i) => value[String(i)] === pair.right)
      );
    case 'ordering':
      return (
        Array.isArray(value) &&
        value.length === answer.items.length &&
        value.every((item, i) => item === i)
      );
    case 'open':
      return false;
  }
}
export function scorePart(
  part: QuestionPart,
  answer: Answer | undefined
): QuestionScore {
  const max = partMarks(part);
  if (part.answer.type === 'open')
    return { awarded: Math.min(max, Math.max(0, part.awarded ?? 0)), max };
  return { awarded: closedCorrect(part, answer) ? max : 0, max };
}
export function scoreQuestion(
  question: Question,
  answers: Answers
): QuestionScore {
  return sumScores(
    question.parts.map((part) => scorePart(part, answers[part.id]))
  );
}
/** An open part's per-item marks; a blank answer earns 0 on every item. */
export function applyItemAwards(
  part: QuestionPart,
  itemAwards: number[] = part.markscheme.map(() => 0)
): QuestionPart {
  return {
    ...part,
    awarded: itemAwards.reduce((sum, award) => sum + award, 0),
    itemAwards,
  };
}
export function shuffledIndices(length: number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}
export function emptyAnswer(part: QuestionPart): Answer {
  switch (part.answer.type) {
    case 'mcq':
    case 'multi':
      return [];
    case 'boolean':
    case 'ordering':
      return null;
    case 'short':
    case 'open':
      return '';
    case 'matching':
      return {};
  }
}
export function answerKey(question: Question): Answers {
  return Object.fromEntries(
    question.parts.map((part) => {
      const answer = part.answer;
      let value: Answer;
      switch (answer.type) {
        case 'mcq':
        case 'multi':
        case 'boolean':
          value = answer.correct;
          break;
        case 'short':
        case 'open':
          value = answer.accepted[0] ?? '';
          break;
        case 'ordering':
          value = answer.items.map((_, i) => i);
          break;
        case 'matching':
          value = Object.fromEntries(
            answer.pairs.map((pair, i) => [String(i), pair.right])
          );
          break;
      }
      return [part.id, value];
    })
  );
}
export function sumScores(scores: QuestionScore[]): QuestionScore {
  return scores.reduce(
    (total, score) => ({
      awarded: total.awarded + score.awarded,
      max: total.max + score.max,
    }),
    { awarded: 0, max: 0 }
  );
}
