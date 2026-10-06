import type { QuestionPart } from '@/api/types';
import type { LearnerPart } from '@/features/questions/types';
import { quantityValuePattern } from '@/features/questions/validation';

/**
 * A learner's answer per part, as the server takes it: option indices for
 * multiple choice, true/false, typed text, one string per gap, the items'
 * texts in the learner's order for ordering, and the chosen option's text per
 * item for matching (learners read those two shuffled).
 *
 * The browser never grades: the server does (`questions.ScorePart`) and returns
 * the key with the result. The scorer below emulates it for the MSW mocks,
 * and grade.test.ts runs it over the server's shared fixtures.
 */
export type Answer =
  | number[]
  | boolean
  | string
  | string[]
  | Record<string, string>
  | null;
export type Answers = Record<string, Answer>;
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
function fuzzyMatch(a: string, b: string, threshold = 0.85): boolean {
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
export const formatPoints = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);
function shortCorrect(
  accepted: string[],
  value: string,
  unit: string | undefined
): boolean {
  if (unit) {
    const numeric = quantityValue(value);
    return (
      numeric !== undefined &&
      accepted.some((expected) => {
        const quantity = quantityValue(expected);
        return quantity !== undefined && sameQuantity(quantity, numeric);
      })
    );
  }
  return accepted.some((expected) => fuzzyMatch(expected, value));
}
/** Whether each scored item is right: matching pairs and gaps score one by
 * one, every other closed answer is a single item. A gap must equal one of its
 * accepted answers, ignoring case and spacing; there is no typo tolerance. */
function itemResults(part: QuestionPart, value: Answer | undefined): boolean[] {
  const answer = part.answer;
  if (answer.type === 'matching')
    return answer.pairs.map(
      (pair, i) =>
        value != null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value[String(i)] === answer.options[pair.right]
    );
  if (answer.type === 'gaps')
    return answer.accepted.map((accepted, i) => {
      const typed = Array.isArray(value) ? value[i] : undefined;
      return (
        typeof typed === 'string' &&
        norm(typed) !== '' &&
        accepted.some((expected) => norm(expected) === norm(typed))
      );
    });
  return [closedCorrect(part, value)];
}
function closedCorrect(part: QuestionPart, value: Answer | undefined): boolean {
  const answer = part.answer;
  if (value == null) return false;
  switch (answer.type) {
    case 'mcq':
    case 'multi':
      return (
        Array.isArray(value) &&
        new Set<number | string>(value).size === value.length &&
        value.length === answer.correct.length &&
        value.every((i) => typeof i === 'number' && answer.correct.includes(i))
      );
    case 'boolean':
      return value === answer.correct;
    case 'short':
      return (
        typeof value === 'string' &&
        shortCorrect(answer.accepted, value, answer.unit)
      );
    case 'ordering':
      return (
        Array.isArray(value) &&
        value.length === answer.items.length &&
        value.every((item, i) => item === answer.items[i])
      );
    case 'matching':
    case 'gaps':
      return itemResults(part, value).every(Boolean);
    case 'open':
      return false;
  }
}
/** Closed parts earn each right item's share of the marks, rounded down to a
 * half mark; a single-item answer is all or nothing. `items` says whether
 * each scored item is right; open parts have none (Jev grades them). */
export function scorePart(
  part: QuestionPart,
  answer: Answer | undefined
): { awarded: number; max: number; items: boolean[] } {
  const max = part.marks;
  if (part.answer.type === 'open')
    return {
      awarded: Math.min(max, Math.max(0, part.awarded ?? 0)),
      items: [],
      max,
    };
  const items = itemResults(part, answer);
  const right = items.filter(Boolean).length;
  return {
    awarded: Math.floor(((max * right) / items.length) * 2) / 2,
    items,
    max,
  };
}
/** An open part's per-item marks; a blank answer earns 0 on every item. */
export function applyItemAwards(
  part: QuestionPart,
  itemAwards: number[] = part.markscheme?.map(() => 0) ?? []
): QuestionPart {
  return {
    ...part,
    awarded: itemAwards.reduce((sum, award) => sum + award, 0),
    itemAwards,
  };
}
export function emptyAnswer(part: QuestionPart | LearnerPart): Answer {
  switch (part.answer.type) {
    case 'gaps':
      return Array.from(
        {
          length:
            'gaps' in part.answer
              ? part.answer.gaps
              : part.answer.accepted.length,
        },
        () => ''
      );
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
