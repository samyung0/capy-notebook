import type { MemberProgress, MembersTopic, SummaryTopic } from '@/api/types';
import { m } from '@/i18n';

export type MembersSort = 'attention' | 'name';
export type MembersShow = 'summary' | 'topics';
type Label = SummaryTopic['label'];

/** A topic's name, Other files for the group without one. */
export const topicName = (t: { group: string; name?: string }) =>
  t.group === 'others' ? m.topic_other_files() : (t.name ?? '');

const key = (t: { group: string; topicId?: string }) => t.topicId ?? t.group;

/** A member's standing in one of By topic's columns. */
export const standingIn = (member: MemberProgress, topic: MembersTopic) =>
  member.topics.find((t) => key(t) === key(topic));

export const needsPractice = (member: MemberProgress) =>
  member.topics.filter((t) => t.label === 'needs_practice');

/** Needs attention (board Main): missing work first, then the most topics that
 * need practice, then the lowest overall; no grade yet sorts after a grade.
 * Ties keep the server's order, by name. */
export function sortMembers(members: MemberProgress[], sort: MembersSort) {
  if (sort === 'name') return members;
  const overall = (m: MemberProgress) => m.overall ?? Number.POSITIVE_INFINITY;
  return [...members].sort(
    (a, b) =>
      b.missing - a.missing ||
      needsPractice(b).length - needsPractice(a).length ||
      overall(a) - overall(b)
  );
}

/** The Needs practice column: the topics that need it, else Attempted while
 * nothing is past Attempted, else nothing flagged; Not started before any
 * answer. */
export function focusOf(
  member: MemberProgress
):
  | { kind: 'topics'; topics: SummaryTopic[] }
  | { kind: 'attempted' | 'nothing' | 'not_started' } {
  const topics = needsPractice(member);
  if (topics.length > 0) return { kind: 'topics', topics };
  const labels = member.topics.map((t) => t.label);
  if (labels.every((l) => l === 'not_started')) return { kind: 'not_started' };
  if (labels.every((l) => l === 'not_started' || l === 'attempted'))
    return { kind: 'attempted' };
  return { kind: 'nothing' };
}

/** Strongest first, for breaking ties. */
const STRENGTH: Label[] = [
  'mastered',
  'proficient',
  'familiar',
  'attempted',
  'needs_practice',
  'not_started',
];

/** The All members row's count for a topic (board G4): how many need practice
 * when any do, else the commonest label, a tie going to the stronger. */
export function topicCount(members: MemberProgress[], topic: MembersTopic) {
  const counts = new Map<Label, number>();
  for (const member of members) {
    const label = standingIn(member, topic)?.label ?? 'not_started';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const needing = counts.get('needs_practice');
  if (needing) return { count: needing, label: 'needs_practice' as const };
  let best: { count: number; label: Label } | null = null;
  for (const label of STRENGTH) {
    const count = counts.get(label) ?? 0;
    if (count > (best?.count ?? 0)) best = { count, label };
  }
  return best;
}
