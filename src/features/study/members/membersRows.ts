import type { MemberProgress, MembersTopic, SummaryTopic } from '@/api/types';
import { m } from '@/i18n';

/** The columns Study's marks sort by (Epo 2026-11-13): a member's name, their
 * assignments' overall, this week's practice, how many topics need practice,
 * or their standing in one topic (`topic:` and its key). */
export type MembersSort =
  | 'name'
  | 'assignments'
  | 'practice'
  | 'needs'
  | `topic:${string}`;
/** Study's marks for a class's staff: every member, or members × topics. */
export type MembersTab = 'overview' | 'topics';
type Label = SummaryTopic['label'];

/** A topic's name, Other files for the group without one. */
export const topicName = (t: { group: string; name?: string }) =>
  t.group === 'others' ? m.topic_other_files() : (t.name ?? '');

const key = (t: { group: string; topicId?: string }) => t.topicId ?? t.group;

/** A member's standing in one of By topic's columns. */
export const standingIn = (member: MemberProgress, topic: MembersTopic) =>
  member.topics.find((t) => key(t) === key(topic));

/** The share of a topic's latest answers missed, a partial counting half. */
const missedShare = (t: SummaryTopic) =>
  t.asked ? (t.wrong + t.partial / 2) / t.asked : 0;

/** The topics labelled Needs practice, most missed first (Epo 2026-11-19); more
 * answers break a tie, then the workspace's order. */
export const needsPractice = (member: MemberProgress) =>
  member.topics
    .filter((t) => t.label === 'needs_practice')
    .sort((a, b) => missedShare(b) - missedShare(a) || b.asked - a.asked);

/** A topic column's key, for its `topic:` sort. */
export const topicKey = key;

/** Needs attention (board Main), now a filter (Epo 2026-11-13): work missing,
 * or a topic that needs practice. */
export const needsAttention = (member: MemberProgress) =>
  member.missing > 0 || needsPractice(member).length > 0;

/** Weakest to strongest; Attempted (too few answers to label) sits between. */
const LABEL_RANK: Record<Label, number> = {
  attempted: 2,
  familiar: 3,
  mastered: 5,
  needs_practice: 1,
  not_started: 0,
  proficient: 4,
};

/** A column's value for a member; none sorts last either way. */
function columnValue(member: MemberProgress, sort: MembersSort) {
  if (sort === 'assignments') return member.overall;
  if (sort === 'practice') return member.practiceWeek;
  if (sort === 'needs') return needsPractice(member).length;
  if (sort.startsWith('topic:')) {
    const standing = member.topics.find(
      (t) => key(t) === sort.slice('topic:'.length)
    );
    return standing
      ? LABEL_RANK[standing.label] +
          (standing.asked ? standing.right / standing.asked / 10 : 0)
      : undefined;
  }
}

/** Name is the server's order, A to Z; the rest by their value, ties keeping
 * that order. `ascending` false reverses. */
export function sortMembers(
  members: MemberProgress[],
  sort: MembersSort,
  ascending: boolean
) {
  if (sort === 'name') return ascending ? [...members] : [...members].reverse();
  return [...members].sort((x, y) => {
    const a = columnValue(x, sort);
    const b = columnValue(y, sort);
    if (a === undefined || b === undefined)
      return a === b ? 0 : a === undefined ? 1 : -1;
    return ascending ? a - b : b - a;
  });
}

/** The Needs practice column: the topics that need it, else nothing flagged
 * (Attempted only shows By topic); Not started before any answer. */
export function focusOf(
  member: MemberProgress
):
  | { kind: 'topics'; topics: SummaryTopic[] }
  | { kind: 'nothing' | 'not_started' } {
  const topics = needsPractice(member);
  if (topics.length > 0) return { kind: 'topics', topics };
  if (member.topics.every((t) => t.label === 'not_started'))
    return { kind: 'not_started' };
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
