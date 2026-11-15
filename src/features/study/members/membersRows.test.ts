import { describe, expect, it } from 'vitest';
import type { MemberProgress, MembersTopic, SummaryTopic } from '@/api/types';
import {
  focusOf,
  needsAttention,
  sortMembers,
  topicCount,
} from './membersRows';

const topic = (
  topicId: string,
  label: SummaryTopic['label']
): SummaryTopic => ({
  asked: 3,
  group: 'topic',
  label,
  partial: 0,
  right: 1,
  topicId,
  unattempted: 0,
  wrong: 2,
});

const member = (
  name: string,
  over: Partial<MemberProgress> = {}
): MemberProgress => ({
  assigned: 4,
  done: 4,
  missing: 0,
  name,
  practiceWeek: 0,
  storageFull: false,
  topics: [],
  userId: name,
  ...over,
});

describe('sortMembers', () => {
  it('sorts by a column, members without its value last', () => {
    const list = [
      member('Ben', { overall: 0.88 }),
      member('Cara', {
        overall: 0.76,
        topics: [topic('a', 'needs_practice'), topic('b', 'needs_practice')],
      }),
      member('Eve'),
      member('Gus', { overall: 0.53, topics: [topic('a', 'needs_practice')] }),
    ];
    const names = (sorted: typeof list) => sorted.map((m) => m.name);
    expect(names(sortMembers(list, 'assignments', true))).toEqual([
      'Gus',
      'Cara',
      'Ben',
      'Eve',
    ]);
    expect(names(sortMembers(list, 'needs', false))).toEqual([
      'Cara',
      'Gus',
      'Ben',
      'Eve',
    ]);
    expect(names(sortMembers(list, 'name', false))).toEqual([
      'Gus',
      'Eve',
      'Cara',
      'Ben',
    ]);
  });
});

describe('needsAttention', () => {
  it('holds a member with work missing or a topic needing practice', () => {
    expect(needsAttention(member('Dan', { missing: 2 }))).toBe(true);
    expect(
      needsAttention(member('Gus', { topics: [topic('a', 'needs_practice')] }))
    ).toBe(true);
  });
});

describe('focusOf', () => {
  it('names the topics needing practice, or says how far they got', () => {
    expect(
      focusOf(member('a', { topics: [topic('x', 'needs_practice')] }))
    ).toMatchObject({
      kind: 'topics',
    });
    expect(
      focusOf(member('a', { topics: [topic('x', 'attempted')] })).kind
    ).toBe('nothing');
    expect(
      focusOf(member('a', { topics: [topic('x', 'familiar')] })).kind
    ).toBe('nothing');
    expect(focusOf(member('a')).kind).toBe('not_started');
  });
});

describe('topicCount', () => {
  const column: MembersTopic = { group: 'topic', questions: 14, topicId: 'x' };
  it('counts who needs practice first, else the commonest label', () => {
    expect(
      topicCount(
        [
          member('a', { topics: [topic('x', 'needs_practice')] }),
          member('b', { topics: [topic('x', 'mastered')] }),
          member('c', { topics: [topic('x', 'mastered')] }),
        ],
        column
      )
    ).toEqual({ count: 1, label: 'needs_practice' });
    expect(
      topicCount(
        [
          member('a', { topics: [topic('x', 'mastered')] }),
          member('b', { topics: [topic('x', 'familiar')] }),
          member('c'),
          member('d'),
        ],
        column
      )
    ).toEqual({ count: 2, label: 'not_started' });
  });
});
