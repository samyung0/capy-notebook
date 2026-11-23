import { expect, it } from 'vitest';
import * as Y from 'yjs';
import * as limits from '@/api/limits.generated';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import type { Question, QuestionPart } from '@/features/questions/types';
import {
  quizBounds,
  quizCapsIssue,
  quizCounts,
  validateQuestion,
} from '@/features/questions/validation';
import { m } from '@/i18n';
import { editQuestion, readQuestions, writeQuestion } from './liveQuiz';

/* Epo 2026-11-22, "Yes, A everywhere": two people's edits merged past a cap
 * are kept and read whole up to twice it; editors stop at the cap, checked
 * against the quiz as it reads when written. */

type Docs = { content: Y.Doc; keys: Y.Doc };

const copy = (from: Docs): Docs => {
  const to = { content: new Y.Doc(), keys: new Y.Doc() };
  Y.applyUpdate(to.content, Y.encodeStateAsUpdate(from.content));
  Y.applyUpdate(to.keys, Y.encodeStateAsUpdate(from.keys));
  return to;
};
const exchange = (a: Docs, b: Docs) => {
  for (const key of ['content', 'keys'] as const) {
    Y.applyUpdate(a[key], Y.encodeStateAsUpdate(b[key]));
    Y.applyUpdate(b[key], Y.encodeStateAsUpdate(a[key]));
  }
};
const quiz = (questions: Question[]): Docs => {
  const docs = { content: new Y.Doc(), keys: new Y.Doc() };
  for (const question of questions)
    writeQuestion(docs.content, docs.keys, question);
  return docs;
};
const open = (id: string) =>
  exampleQuestion(id, { accepted: [], type: 'open' });
const short = (id: string) =>
  exampleQuestion(id, { accepted: ['a'], type: 'short' });

it('reads a part with marking items two editors added at once as worth their total', () => {
  const a = quiz([open('q1')]);
  const b = copy(a);
  // Each editor adds an item and writes the marks its own items add up to.
  for (const [docs, text] of [
    [a, 'Explains it.'],
    [b, 'Gives an example.'],
  ] as const) {
    const question = structuredClone(readQuestions(docs.content, docs.keys)[0]);
    const part = question.parts[0];
    part.markscheme = [...(part.markscheme ?? []), { marks: 3, text }];
    part.marks = 4;
    writeQuestion(docs.content, docs.keys, question);
  }
  exchange(a, b);
  const [merged] = readQuestions(a.content, a.keys);
  expect(merged.parts[0].markscheme).toHaveLength(3);
  expect(merged.parts[0].marks).toBe(7);
  expect(validateQuestion(merged)).toEqual(merged);
});

it('takes a question two editors added a part to at once past the cap, up to twice it', () => {
  const parts = (count: number): QuestionPart[] =>
    Array.from({ length: count }, (_, i) => ({
      ...short('q').parts[0],
      id: `part-${i}`,
    }));
  const question = (count: number) => ({ ...short('q'), parts: parts(count) });
  for (const count of [
    limits.QUIZ_QUESTION_PARTS_MAX + 1,
    2 * limits.QUIZ_QUESTION_PARTS_MAX,
  ]) {
    const docs = quiz([question(count)]);
    const [read] = readQuestions(docs.content, docs.keys);
    expect(read.parts).toHaveLength(count);
    expect(() => validateQuestion(read)).not.toThrow();
  }
  expect(() =>
    validateQuestion(question(2 * limits.QUIZ_QUESTION_PARTS_MAX + 1))
  ).toThrow();
});

it('takes a quiz past its part caps up to twice them, and an editor adds none past the cap', () => {
  const many = (count: number, make: (id: string) => Question) =>
    Array.from({ length: count }, (_, i) => make(`q${i}`));
  expect(() =>
    quizBounds(many(limits.QUIZ_PARTS_MAX + 1, short))
  ).not.toThrow();
  expect(() =>
    quizBounds(many(2 * limits.QUIZ_PARTS_MAX, short))
  ).not.toThrow();
  expect(() =>
    quizBounds(many(2 * limits.QUIZ_PARTS_MAX + 1, short))
  ).toThrow();
  expect(() =>
    quizBounds(many(2 * limits.QUIZ_OPEN_PARTS_MAX, open))
  ).not.toThrow();
  expect(() =>
    quizBounds(many(2 * limits.QUIZ_OPEN_PARTS_MAX + 1, open))
  ).toThrow();
  // An add past the cap stops; a write that adds none goes, even past it.
  const full = quizCounts(many(limits.QUIZ_PARTS_MAX, short));
  expect(quizCapsIssue(full, { ...full, parts: full.parts + 1 })).toBe(
    m.question_validation_quiz_parts({ max: limits.QUIZ_PARTS_MAX })
  );
  const merged = { ...full, parts: full.parts + 2 };
  expect(quizCapsIssue(merged, merged)).toBeNull();
  expect(quizCapsIssue(merged, { ...merged, parts: merged.parts - 1 })).toBe(
    null
  );
});

it('writes an editor’s question only within the quiz caps as it reads now', () => {
  const docs = quiz(
    Array.from({ length: limits.QUIZ_OPEN_PARTS_MAX }, (_, i) => open(`q${i}`))
  );
  // A new AI-marked question past the cap does not go.
  expect(editQuestion(docs.content, docs.keys, open('extra'))).toBe(
    m.question_validation_quiz_open_parts({
      max: limits.QUIZ_OPEN_PARTS_MAX,
    })
  );
  expect(readQuestions(docs.content, docs.keys)).toHaveLength(
    limits.QUIZ_OPEN_PARTS_MAX
  );
  // Neither does turning a short part into an open one once full...
  expect(editQuestion(docs.content, docs.keys, short('s'))).toBeNull();
  expect(editQuestion(docs.content, docs.keys, open('s'))).not.toBeNull();
  // ...while an edit that adds none (new text) goes.
  const [first] = readQuestions(docs.content, docs.keys);
  const edited = structuredClone(first);
  edited.parts[0].blocks = [{ text: 'Edited.', type: 'text' }];
  expect(editQuestion(docs.content, docs.keys, edited)).toBeNull();
  expect(readQuestions(docs.content, docs.keys)[0].parts[0].blocks).toEqual(
    edited.parts[0].blocks
  );
});
