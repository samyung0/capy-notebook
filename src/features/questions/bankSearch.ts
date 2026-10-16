import {
  type BankExam,
  type BankSubject,
  type BankTopic,
  soleSubject,
  soleTopic,
} from './bank';

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * How well a label matches a lower-cased search: 1 exactly, 2 at its start,
 * 3 at a later word's start, 4 anywhere; 0 not at all.
 */
function matchRank(label: string, needle: string) {
  const text = label.toLocaleLowerCase();
  if (text === needle) return 1;
  if (text.startsWith(needle)) return 2;
  if (!text.includes(needle)) return 0;
  return text.split(WORD_BREAK).some((word) => word.startsWith(needle)) ? 3 : 4;
}

export type ExamHit = { rank: number; exam: BankExam };
export type SubjectHit = ExamHit & { subject: BankSubject };
export type TopicHit = SubjectHit & { item: BankTopic };

/**
 * Exams, subjects and topics matching a search, each list best first. An exam
 * ranks by its name, or at best 3 by its full name or description; subjects
 * and topics by their own names. Levels an exam hides (its one subject, or the
 * one topic of a single-topic exam) are left out. Ties keep syllabus order. The
 * syllabus is already loaded, so search needs no request.
 */
export function searchSyllabus(exams: BankExam[], needle: string) {
  const hits = {
    exams: [] as ExamHit[],
    subjects: [] as SubjectHit[],
    topics: [] as TopicHit[],
  };
  for (const exam of exams) {
    const ranks = [
      matchRank(exam.label, needle),
      ...[exam.fullLabel, exam.description]
        .map((label) => matchRank(label, needle))
        .filter(Boolean)
        .map((rank) => Math.max(rank, 3)),
    ].filter(Boolean);
    if (ranks.length) hits.exams.push({ exam, rank: Math.min(...ranks) });
    if (soleTopic(exam)) continue;
    for (const subject of exam.subjects) {
      const rank = soleSubject(exam) ? 0 : matchRank(subject.label, needle);
      if (rank) hits.subjects.push({ exam, rank, subject });
      for (const item of subject.topics) {
        const rank = matchRank(item.label, needle);
        if (rank) hits.topics.push({ exam, item, rank, subject });
      }
    }
  }
  // Array sort is stable, so equal hits keep syllabus order.
  for (const list of Object.values(hits)) list.sort((a, b) => a.rank - b.rank);
  return hits;
}
