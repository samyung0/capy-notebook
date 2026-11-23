import { HttpResponse, http } from 'msw';
import type {
  MemberAnswer,
  MemberProfile,
  MemberProgress,
  MembersProgress,
  MembersTopic,
  StudyQuestion,
  SummaryTopic,
} from '@/api/types';
import type { Question, QuestionBlock } from '@/features/questions/types';
import { gradeQuestions } from './answerKeys';
import { submittedAttemptId } from './assignments';
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

const CELL: QuestionBlock = {
  description: 'An animal cell seen under a light microscope.',
  height: 540,
  image: { assetId: 'asset_mock_cell_diagram' },
  type: 'image',
  width: 960,
};
const text = (value: string): QuestionBlock => ({ text: value, type: 'text' });

/** Each TOPICS column's questions in reading order, as a prompt, its model
 * answer and what its stem shows first (Epo 2026-11-22: a figure, a table,
 * a chart or a plot before the text), and the quizzes they come from (the
 * first half from the first). */
const QUESTIONS: {
  questions: [string, string, QuestionBlock[]?][];
  quizzes: string[];
}[] = [
  {
    questions: [
      [
        'State one difference between a prokaryotic and a eukaryotic cell.',
        'A prokaryotic cell has no nucleus',
      ],
      [
        'Name the structure that controls what enters and leaves a cell.',
        'Cell membrane',
      ],
      ['Name the structure that supports a plant cell.', 'Cell wall'],
      [
        'Explain why a light microscope cannot show ribosomes.',
        'Its resolution is too low',
      ],
      [
        'Calculate the actual length of a cell drawn 30 mm long at ×1500 magnification.',
        '20 µm',
        [CELL],
      ],
      [
        'Give two structures found in plant cells but not in animal cells.',
        'Cell wall and chloroplasts',
      ],
      [
        'Describe the function of the cytoplasm.',
        'Where most chemical reactions happen',
      ],
      [
        'Suggest why root hair cells have no chloroplasts.',
        'They get no light underground',
      ],
      [
        'Compare the resolution of light and electron microscopes.',
        'An electron microscope has a higher resolution',
      ],
      ['State the function of the nucleus.', "Controls the cell's activities"],
      [
        'Explain how a palisade cell is adapted for photosynthesis.',
        'It has many chloroplasts',
      ],
      ['Name the unit used to measure the size of a cell.', 'Micrometre'],
      [
        'Describe how to prepare a slide of onion cells.',
        'Peel a thin layer, stain it with iodine and add a coverslip',
      ],
      [
        'Give one reason why cells differentiate.',
        'To carry out a specific function',
      ],
    ],
    quizzes: ['Cells check', 'Past paper 2025 P1'],
  },
  {
    questions: [
      ['State the function of mitochondria.', 'Aerobic respiration'],
      ['Name the organelle where proteins are made.', 'Ribosome'],
      [
        'Explain why muscle cells contain many mitochondria.',
        'They need a lot of energy',
        [
          {
            kind: 'bar',
            labels: ['Skin cell', 'Liver cell', 'Heart muscle cell'],
            series: [{ name: 'Mitochondria', values: [300, 1500, 5000] }],
            title: 'Mitochondria in one cell',
            type: 'chart',
            yTitle: 'Mitochondria',
          },
        ],
      ],
      [
        'Describe the role of the rough endoplasmic reticulum.',
        'It carries the proteins its ribosomes make',
      ],
      ['State where photosynthesis happens in a plant cell.', 'Chloroplasts'],
      [
        'Explain how the Golgi apparatus packages proteins for secretion.',
        'It modifies them and packs them into vesicles',
      ],
      ['Name the organelle that contains digestive enzymes.', 'Lysosome'],
      [
        'Describe the structure of a chloroplast.',
        'A double membrane around stacks of thylakoids',
      ],
      [
        'Give the function of the smooth endoplasmic reticulum.',
        'It makes lipids',
      ],
      [
        'Explain why many ribosomes sit on the endoplasmic reticulum.',
        'The proteins they make go straight into it',
      ],
      [
        'Suggest why sperm cells have many mitochondria in the mid-piece.',
        'To release energy for swimming',
      ],
      [
        'State the function of the vacuole in a plant cell.',
        'It holds cell sap and keeps the cell firm',
      ],
      [
        'Describe the path of a protein from a ribosome to the cell membrane.',
        'Rough ER, Golgi apparatus, vesicle, membrane',
      ],
      ['Name the organelle that holds the cell’s DNA.', 'Nucleus'],
      [
        'Explain why red blood cells have no nucleus.',
        'More room for haemoglobin',
      ],
      [
        'Compare the inner and outer membranes of a mitochondrion.',
        'The inner membrane is folded into cristae',
      ],
    ],
    quizzes: ['Organelles practice', 'Past paper 2025 P1'],
  },
  {
    questions: [
      [
        'Explain why a red blood cell bursts in pure water.',
        'Water enters by osmosis and it has no cell wall',
      ],
      [
        'Define diffusion.',
        'The net movement of particles from a high to a low concentration',
      ],
      [
        'Describe how active transport differs from diffusion.',
        'It moves substances against a gradient using energy',
      ],
      [
        "Explain why plant cells don't burst in pure water.",
        'The cell wall stops them',
      ],
      [
        'Predict the change in mass of potato cylinders left in a concentrated sugar solution.',
        'Their mass goes down',
        [
          text(
            'A student left potato cylinders in sugar solutions for 30 minutes.'
          ),
          {
            header: true,
            rows: [
              ['Sugar (mol/dm³)', 'Change in mass (%)'],
              ['0.0', '+12.0'],
              ['0.2', '+4.8'],
              ['0.4', '−2.0'],
            ],
            type: 'table',
          },
        ],
      ],
      [
        'Give two factors that increase the rate of diffusion.',
        'A higher temperature and a steeper gradient',
      ],
      [
        'Describe the fluid mosaic model of the cell membrane.',
        'Proteins float in a phospholipid bilayer',
      ],
      [
        'Explain how root hair cells take up mineral ions.',
        'By active transport',
      ],
      [
        'State what is meant by a partially permeable membrane.',
        'It lets only some molecules through',
      ],
    ],
    quizzes: ['Cells check', 'Transport quiz'],
  },
  {
    questions: [
      ['Name the four bases found in DNA.', 'A, T, C and G'],
      [
        'Describe the structure of a DNA molecule.',
        'A double helix of two strands',
      ],
      [
        'State what is meant by a gene.',
        'A section of DNA that codes for a protein',
      ],
      [
        'Explain how a change in the base sequence can change a protein.',
        'It changes the order of amino acids',
      ],
      ['Give the base that pairs with adenine.', 'Thymine'],
      [
        'Describe the role of mRNA in protein synthesis.',
        'It carries the code from the nucleus to a ribosome',
      ],
      ['State where DNA is found in a eukaryotic cell.', 'In the nucleus'],
      [
        'Explain why DNA replication is called semi-conservative.',
        'Each new molecule keeps one old strand',
      ],
    ],
    quizzes: ['Genetics worksheet'],
  },
  {
    questions: [
      [
        'Give the expected ratio of offspring from a cross of two heterozygous parents.',
        '3:1',
        [
          {
            header: true,
            rows: [
              ['', 'T', 't'],
              ['T', 'TT', 'Tt'],
              ['t', 'Tt', 'tt'],
            ],
            type: 'table',
          },
        ],
      ],
      ['Define the term allele.', 'A different version of a gene'],
      ['Give the share of Tt offspring from a cross between Tt and tt.', '50%'],
      [
        'Explain the difference between genotype and phenotype.',
        'Genotype is the alleles, phenotype is the trait shown',
      ],
      ['State what is meant by homozygous.', 'Two identical alleles'],
      [
        'Explain how sex is determined in humans.',
        'By the X and Y chromosomes',
      ],
      [
        'Describe what a recessive allele is.',
        'One shown only when two copies are present',
      ],
      [
        'Give the genotype of a person who shows a recessive trait.',
        'Homozygous recessive',
      ],
      [
        'Explain why two brown-eyed parents can have a blue-eyed child.',
        'Both carry the recessive allele',
      ],
      ['State the number of chromosomes in a human gamete.', '23'],
      [
        'Describe what codominance means, with an example.',
        'Both alleles are shown, as in AB blood',
      ],
    ],
    quizzes: ['Genetics worksheet', 'Past paper 2025 P1'],
  },
  {
    questions: [
      [
        'Describe how natural selection leads to evolution.',
        'Better-suited variants survive and pass on their alleles',
      ],
      [
        'Explain how antibiotic resistance spreads in bacteria.',
        'Resistant bacteria survive and reproduce',
        [
          {
            series: [
              {
                name: 'Resistant',
                points: [
                  [0, 2],
                  [2, 10],
                  [4, 35],
                  [6, 70],
                  [8, 90],
                ],
              },
            ],
            title: 'Resistant bacteria during a course of antibiotics',
            type: 'plot',
            unit: '%',
            xTitle: 'Day',
            yTitle: 'Resistant (%)',
          },
          text('The plot follows one infection over eight days.'),
        ],
      ],
      ['Give one piece of evidence for evolution.', 'Fossils'],
      [
        'Define the term species.',
        'Organisms that can breed to give fertile offspring',
      ],
      [
        'Explain why fossils of early organisms are rare.',
        'Soft bodies rarely fossilise',
      ],
    ],
    quizzes: ['Evolution starter'],
  },
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

/** A member's questions, read only for staff, matching their standings: per
 * column the first `asked` were answered, the wrong ones spread among them,
 * the rest not tried. Each comes with its question and the member's latest
 * answer, the model answer when right, another question's when wrong. */
function memberQuestions(
  name: string
): { answer?: MemberAnswer; row: StudyQuestion }[] {
  const line = LINES[name];
  return TOPICS.flatMap((topic, t) => {
    const [, right, asked] = line?.cells[t] ?? [null, 0, 0];
    const wrong = asked - right;
    const { questions, quizzes } = QUESTIONS[t];
    return questions.map(([prompt, model, lead = []], i) => {
      const quiz =
        quizzes[Math.min(quizzes.length - 1, (2 * i) / questions.length) | 0];
      const questionId = `${topic.topicId}_q${i + 1}`;
      const base = {
        group: 'topic' as const,
        materialId: `mt_${quiz.toLowerCase().replaceAll(' ', '_')}`,
        materialTitle: quiz,
        questionId,
        // The stem's text when it has one, as the server's PromptText reads.
        text:
          lead.find(
            (b): b is Extract<QuestionBlock, { type: 'text' }> =>
              b.type === 'text'
          )?.text ?? prompt,
        topicId: topic.topicId,
        topicName: topic.name,
      };
      if (i >= asked)
        return { row: { ...base, misses: 0, result: 'unattempted' as const } };
      const missed =
        Math.floor(((i + 1) * wrong) / asked) > Math.floor((i * wrong) / asked);
      const at = new Date(
        Date.now() - (5 + 9 * i + 31 * t) * 3_600_000
      ).toISOString();
      const question: Question = {
        id: questionId,
        labels: 'letters',
        layout: 'paper',
        parts: [
          {
            answer: { accepted: [model], type: 'short' },
            blocks: [text(prompt)],
            id: `${questionId}:part`,
            marks: 1,
            solution: [],
          },
        ],
        stem: lead,
      };
      const given = missed ? questions[(i + 1) % questions.length][1] : model;
      const answers = { [`${questionId}:part`]: given };
      return {
        answer: {
          answers,
          at,
          question: gradeQuestions([question], answers).questions[0],
        },
        row: {
          ...base,
          at,
          misses: missed ? 1 + ((i + t) % 2) : 0,
          result: missed ? ('wrong' as const) : ('right' as const),
        },
      };
    });
  });
}

/** The ones not right, most missed first, then the latest answered. */
const wrongFirst = (questions: StudyQuestion[]) =>
  questions
    .filter((q) => q.result === 'wrong' || q.result === 'partial')
    .sort(
      (a, b) => b.misses - a.misses || (b.at ?? '').localeCompare(a.at ?? '')
    );

/** GET …/members/{memberId}/questions: a column's questions in reading
 * order, or Frequently wrong's. */
function memberQuestionList(
  workspaceId: string,
  memberId: string,
  list: string | null,
  topicId: string | null
): StudyQuestion[] | null {
  const member = viewers(workspaceId).find((m) => m.userId === memberId);
  if (!member) return null;
  const all = memberQuestions(member.name).map((q) => q.row);
  if (list === 'wrong') return wrongFirst(all);
  if (list === 'others') return [];
  if (!TOPICS.some((t) => t.topicId === topicId)) return null;
  return all.filter((q) => q.topicId === topicId);
}

/** Members whose profile leaves sections empty, to see the page without them:
 * no wrong questions, no recent activity, no assignments, or nothing at all
 * (a class with no quizzes yet, so no topics either). */
const EMPTY: Record<
  string,
  ('activity' | 'assignments' | 'missed' | 'topics')[]
> = {
  'Cara Moss': ['activity'],
  'Dan Kim': ['activity', 'assignments', 'missed', 'topics'],
  'Farah Ali': ['assignments'],
  'Gus Ito': ['missed'],
};

function profile(workspaceId: string, memberId: string) {
  const member = progress(workspaceId).members.find(
    (m) => m.userId === memberId
  );
  if (!member) return null;
  const full = fullProfile(member);
  const empty = EMPTY[member.name] ?? [];
  return {
    ...full,
    activity: empty.includes('activity') ? [] : full.activity,
    assignments: empty.includes('assignments') ? [] : full.assignments,
    // Nothing at all: never active, no mark to average.
    lastActiveAt: empty.length === 4 ? undefined : full.lastActiveAt,
    missed: empty.includes('missed') ? [] : full.missed,
    overall: empty.includes('assignments') ? undefined : full.overall,
    topics: empty.includes('topics') ? [] : full.topics,
  } satisfies MemberProfile;
}

function fullProfile(member: MemberProgress) {
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
        attemptId: submittedAttemptId('as_cells', member.userId),
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
        attemptId: submittedAttemptId('as_paper', member.userId),
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
    // Frequently wrong's first three, as the server cuts the wrong list.
    missed: wrongFirst(memberQuestions(member.name).map((q) => q.row)).slice(
      0,
      3
    ),
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
  http.get(
    '/api/workspaces/:id/study/members/:memberId/questions',
    ({ params, request }) => {
      const search = new URL(request.url).searchParams;
      const questions = memberQuestionList(
        String(params.id),
        String(params.memberId),
        search.get('list'),
        search.get('topicId')
      );
      return questions
        ? HttpResponse.json({ questions })
        : HttpResponse.json({ title: 'Not Found' }, { status: 404 });
    }
  ),
  http.get(
    '/api/workspaces/:id/study/members/:memberId/answers/:materialId/:questionId',
    ({ params }) => {
      const member = viewers(String(params.id)).find(
        (m) => m.userId === params.memberId
      );
      const answer = member
        ? memberQuestions(member.name).find(
            (q) =>
              q.row.materialId === params.materialId &&
              q.row.questionId === params.questionId
          )?.answer
        : undefined;
      return answer
        ? HttpResponse.json(answer)
        : HttpResponse.json({ title: 'Not Found' }, { status: 404 });
    }
  ),
];
