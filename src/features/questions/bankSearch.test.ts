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
    'Summary completion',
  ]),
  exam('drive', 'Driving', 'One paper on road rules.', ['Theory paper']),
];
exams[0].subjects.push({
  id: 'dse-maths',
  label: 'Mathematics',
  topics: [{ id: 'Mensuration', label: 'Mensuration', reviewed: 0, total: 1 }],
});
const ids = (needle: string) => {
  const hits = searchSyllabus(exams, needle);
  return {
    exams: hits.exams.map((hit) => hit.exam.id),
    subjects: hits.subjects.map((hit) => hit.subject.id),
    topics: hits.topics.map((hit) => hit.item.id),
  };
};

describe('searchSyllabus', () => {
  it('ranks start, word start, then inside matches', () => {
    expect(ids('area').topics).toEqual(['Area practice', 'Surface area']);
    // English is a description word start.
    expect(ids('eng')).toEqual({
      exams: ['ielts'],
      subjects: [],
      topics: ['Arc length'],
    });
  });

  it('matches each level by its own name', () => {
    expect(ids('ielts')).toEqual({
      exams: ['ielts'],
      subjects: [],
      topics: [],
    });
    expect(ids('math')).toEqual({
      exams: [],
      subjects: ['dse-maths'],
      topics: [],
    });
  });

  it('leaves out levels an exam hides', () => {
    expect(ids('driving').exams).toEqual(['drive']);
    expect(ids('theory').topics).toEqual([]);
    // IELTS has one subject, so its name is not a hit.
    expect(ids('subject').subjects).toEqual(['dse-subject']);
  });
});
