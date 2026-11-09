import { HttpResponse, http } from 'msw';
import type {
  MemberProfile,
  MemberProgress,
  MembersProgress,
  MembersTopic,
  SummaryTopic,
} from '@/api/types';
import { mockWorkspaceMembers } from './workspaceMembers';

/** Study → Members in mock mode: Biology 101's viewers with the numbers the
 * boards draw (Main, G4, G2), so the page can be checked against them. */

const TOPICS: MembersTopic[] = [
  { group: 'topic', name: 'Cell structure', questions: 14, topicId: 'ch_1' },
  { group: 'topic', name: 'Organelles', questions: 16, topicId: 'mt_org' },
  {
    group: 'topic',
    name: 'Membranes and transport',
    questions: 9,
    topicId: 'ch_2',
  },
  { group: 'topic', name: 'DNA and genes', questions: 8, topicId: 'mt_dna' },
  { group: 'topic', name: 'Inheritance', questions: 11, topicId: 'ch_3' },
  { group: 'topic', name: 'Evolution', questions: 5, topicId: 'mt_evo' },
];

type Cell = [SummaryTopic['label'], number, number] | null;
type Line = {
  overall?: number;
  done: number;
  missing: number;
  practiceWeek: number;
  storageFull?: boolean;
  /** Label, right and asked per TOPICS column; null is not started. */
  cells: Cell[];
};

const P = 'proficient';
const M = 'mastered';
const F = 'familiar';
const N = 'needs_practice';
const A = 'attempted';

const LINES: Record<string, Line> = {
  'Ben Lee': {
    cells: [
      [P, 12, 14],
      [M, 14, 16],
      [F, 6, 9],
      [F, 5, 8],
      [P, 9, 11],
      [A, 2, 2],
    ],
    done: 3,
    missing: 0,
    overall: 0.88,
    practiceWeek: 30,
  },
  'Cara Moss': {
    cells: [[F, 5, 8], [P, 9, 10], [N, 1, 4], [A, 1, 2], [N, 2, 6], null],
    done: 3,
    missing: 0,
    overall: 0.76,
    practiceWeek: 24,
  },
  'Dan Kim': {
    cells: [[A, 1, 2], [A, 2, 2], [A, 0, 1], [A, 1, 1], null, null],
    done: 1,
    missing: 2,
    overall: 0.09,
    practiceWeek: 3,
  },
  'Eve Park': {
    cells: [
      [P, 13, 14],
      [M, 15, 16],
      [F, 5, 7],
      [P, 7, 8],
      [F, 7, 10],
      [A, 1, 2],
    ],
    done: 3,
    missing: 0,
    overall: 0.92,
    practiceWeek: 18,
  },
  'Farah Ali': {
    cells: [[P, 11, 13], [F, 10, 14], [N, 2, 6], [F, 4, 6], [F, 5, 8], null],
    done: 4,
    missing: 0,
    overall: 0.78,
    practiceWeek: 0,
    storageFull: true,
  },
  'Gus Ito': {
    cells: [[N, 4, 10], [F, 7, 12], [N, 1, 5], [N, 1, 4], [A, 1, 2], null],
    done: 2,
    missing: 0,
    overall: 0.53,
    practiceWeek: 12,
  },
};

function standings(line: Line | undefined): SummaryTopic[] {
  return TOPICS.map((topic, i) => {
    const cell = line?.cells[i] ?? null;
    const [label, right, asked] = cell ?? ['not_started', 0, 0];
    return {
      asked,
      group: 'topic' as const,
      label,
      name: topic.name,
      partial: 0,
      right,
      topicId: topic.topicId,
      unattempted: Math.max(0, topic.questions - asked),
      wrong: asked - right,
    };
  });
}

const viewers = (workspaceId: string) =>
  mockWorkspaceMembers.filter(
    (m) => m.workspaceId === workspaceId && m.role === 'viewer'
  );

function progress(workspaceId: string): MembersProgress {
  const members: MemberProgress[] = viewers(workspaceId)
    .map((m) => {
      const line = LINES[m.name];
      return {
        assigned: 4,
        avatarUrl: undefined,
        done: line?.done ?? 0,
        missing: line?.missing ?? 0,
        name: m.name,
        overall: line?.overall,
        practiceWeek: line?.practiceWeek ?? 0,
        storageFull: line?.storageFull ?? false,
        topics: standings(line),
        userId: m.userId,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { members, topics: members.length ? TOPICS : [] };
}

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

function profile(workspaceId: string, memberId: string) {
  const member = progress(workspaceId).members.find(
    (m) => m.userId === memberId
  );
  if (!member) return null;
  return {
    activity: [
      {
        at: daysAgo(1),
        kind: 'practice',
        questions: 10,
        title: 'Organelles practice',
      },
      {
        at: daysAgo(2),
        group: 'topic',
        kind: 'review',
        questions: 6,
        topicName: 'Membranes and transport',
      },
      {
        at: daysAgo(4),
        kind: 'assignment',
        questions: 12,
        title: 'Past paper 2025 P1',
      },
    ],
    assigned: member.assigned,
    assignments: [
      {
        attemptId: 'at_cells',
        doneAt: daysAgo(11),
        id: 'as_cells',
        kind: 'marked',
        mark: 14,
        missing: false,
        running: false,
        title: 'Cells check',
        total: 20,
        waitingMarks: 0,
      },
      {
        dueAt: daysAgo(-2),
        id: 'as_genetics',
        kind: 'marked',
        missing: false,
        running: true,
        title: 'Genetics worksheet',
        waitingMarks: 0,
      },
      {
        attemptId: 'at_paper',
        doneAt: daysAgo(1),
        id: 'as_paper',
        kind: 'marked',
        mark: 31,
        missing: false,
        running: false,
        title: 'Past paper 2025 P1',
        total: 40,
        waitingMarks: 0,
      },
    ],
    avatarUrl: member.avatarUrl,
    done: member.done,
    joinedAt: daysAgo(67),
    lastActiveAt: new Date().toISOString(),
    missed: [
      {
        at: daysAgo(2),
        group: 'topic',
        materialId: 'mt_quiz',
        misses: 2,
        questionId: 'q1',
        text: 'Explain why a red blood cell bursts in pure water.',
        topicId: 'ch_2',
        topicName: 'Membranes and transport',
      },
      {
        at: daysAgo(3),
        group: 'topic',
        materialId: 'mt_quiz',
        misses: 2,
        questionId: 'q2',
        text: 'Give the expected ratio of offspring from a cross of two heterozygous parents.',
        topicId: 'ch_3',
        topicName: 'Inheritance',
      },
      {
        at: daysAgo(4),
        group: 'topic',
        materialId: 'mt_quiz',
        misses: 2,
        questionId: 'q3',
        text: 'State one difference between a prokaryotic and a eukaryotic cell.',
        topicId: 'ch_1',
        topicName: 'Cell structure',
      },
    ],
    missing: member.missing,
    name: member.name,
    overall: member.overall,
    storageFull: member.storageFull,
    topics: member.topics,
    userId: member.userId,
  } satisfies MemberProfile;
}

export const membersHandlers = [
  http.get('/api/workspaces/:id/study/members', ({ params }) =>
    HttpResponse.json(progress(String(params.id)))
  ),
  http.get('/api/workspaces/:id/study/members/:memberId', ({ params }) => {
    const body = profile(String(params.id), String(params.memberId));
    return body
      ? HttpResponse.json(body)
      : HttpResponse.json({ title: 'Not Found' }, { status: 404 });
  }),
];
