import { describe, expect, it } from 'vitest';
import type { MemberProgress, MembersTopic, SummaryTopic } from '@/api/types';
import { focusOf, sortMembers, topicCount } from './membersRows';

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
  it('puts missing work, then topics needing practice, then the lowest overall first', () => {
    const list = [
      member('Ben', { overall: 0.88 }),
      member('Cara', {
        overall: 0.76,
        topics: [topic('a', 'needs_practice'), topic('b', 'needs_practice')],
      }),
      member('Dan', { missing: 2, overall: 0.09 }),
      member('Eve'),
      member('Gus', { overall: 0.53, topics: [topic('a', 'needs_practice')] }),
      member('Farah', { overall: 0.78 }),
    ];
    expect(sortMembers(list, 'attention').map((m) => m.name)).toEqual([
      'Dan',
      'Cara',
      'Gus',
      'Farah',
      'Ben',
      'Eve',
    ]);
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
    ).toBe('attempted');
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
