import { describe, expect, it } from 'vitest';
import type { BankExam } from './bank';
import { searchSyllabus } from './bankSearch';

const exam = (
  id: string,
  label: string,
  description: string,
  topics: string[]
): BankExam => ({
  cover: { color: '#7866cf', style: 'type' },
  description,
  fullLabel: label,
  id,
  label,
  subjects: [
    {
      id: `${id}-subject`,
      label: 'Subject',
      topics: topics.map((topic) => ({
        id: topic,
        label: topic,
        reviewed: 0,
        total: 1,
      })),
    },
  ],
});

const exams = [
  exam('dse', 'HKDSE', 'Hong Kong university entrance exam.', [
    'Surface area',
    'Area practice',
    'Arc length',
  ]),
  exam('ielts', 'IELTS', 'English test for study and work.', [
    'Matching headings',
  ]),
];
const order = (needle: string) =>
  searchSyllabus(exams, needle).map((hit) =>
    hit.kind === 'exam' ? hit.exam.id : hit.item.id
  );

describe('searchSyllabus', () => {
  it('ranks start, word start, inside, then parent-only matches', () => {
    expect(order('area')).toEqual(['Area practice', 'Surface area']);
    // English is a description word start; Arc length only contains "eng".
    expect(order('eng')).toEqual(['ielts', 'Arc length']);
    // The exam itself first, then its topics through the exam's name.
    expect(order('ielts')).toEqual(['ielts', 'Matching headings']);
  });
});
