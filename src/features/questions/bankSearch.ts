import {
  type BankExam,
  type BankSubject,
  type BankTopic,
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

export type SyllabusHit =
  | { kind: 'exam'; rank: number; exam: BankExam }
  | {
      kind: 'topic';
      rank: number;
      exam: BankExam;
      subject: BankSubject;
      item: BankTopic;
    };

/**
 * Exams and topics matching a search, best first. An exam ranks by its name,
 * or at best 3 by its full name or description; a topic by its own name, or 5
 * when only its subject or exam matches; a single-topic exam lists only
 * itself. Ties keep exams first, then syllabus order. The syllabus is already loaded, so search needs no request.
 */
export function searchSyllabus(exams: BankExam[], needle: string) {
  const hits: SyllabusHit[] = [];
  for (const exam of exams) {
    const own = matchRank(exam.label, needle);
    const more = [exam.fullLabel, exam.description]
      .map((label) => matchRank(label, needle))
      .filter(Boolean)
      .map((rank) => Math.max(rank, 3));
    const examRank = Math.min(...[own, ...more].filter(Boolean));
    if (examRank !== Number.POSITIVE_INFINITY)
      hits.push({ exam, kind: 'exam', rank: examRank });
    if (soleTopic(exam)) continue;
    for (const subject of exam.subjects)
      for (const item of subject.topics) {
        const rank =
          matchRank(item.label, needle) ||
          (matchRank(subject.label, needle) || own ? 5 : 0);
        if (rank) hits.push({ exam, item, kind: 'topic', rank, subject });
      }
  }
  // Array sort is stable, so equal hits keep syllabus order.
  return hits.sort(
    (a, b) =>
      a.rank - b.rank || Number(a.kind === 'topic') - Number(b.kind === 'topic')
  );
}
