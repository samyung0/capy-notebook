import { delay, HttpResponse, http } from 'msw';
import type {
  BankCopyReq,
  BankTopicMarks,
  BankTopicProgress,
} from '@/api/types';
import {
  createMaterialDocument,
  quizNode,
} from '@/features/materials/document';
import type {
  BankDetail,
  BankRow,
  BankSyllabus,
} from '@/features/questions/bank';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import type { Question } from '@/features/questions/types';
import { questionMarks } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import type { Answers } from '@/features/quizzes/grade';
import { gradeQuestions, learnerView } from './answerKeys';
import * as db from './db';
import { uid } from './db';

const assetsUrl = 'https://bank-fixtures.invalid/assets';
const assets = new Map<string, File>();
const samples: Question[] = [
  exampleQuestion('bank-quadratic', {
    accepted: ['3'],
    type: 'short',
    unit: 'cm',
  }),
  exampleQuestion('bank-match', {
    options: ['A', 'B', 'C', 'Unused heading'],
    pairs: [
      { left: 'Paragraph 1', right: 0 },
      { left: 'Paragraph 2', right: 1 },
    ],
    type: 'matching',
  }),
];
samples[0].stem = [
  {
    text: 'A rectangle has area $12\\,\\mathrm{cm}^2$ and length $4\\,\\mathrm{cm}$.',
    type: 'text',
  },
];
samples[0].parts[0].blocks = [{ text: 'Find its width.', type: 'text' }];
samples[0].parts[0].solution = [
  { text: '$w=12/4=3\\,\\mathrm{cm}$.', type: 'text' },
];
samples[1].stem = [
  {
    text: 'Practice matching headings. The choice pool can contain unused headings.',
    type: 'text',
  },
];
samples[1].parts[0].blocks = [
  { text: 'Match the paragraphs to their headings.', type: 'text' },
];
samples[1].parts[0].solution = [
  { text: 'A summarizes paragraph 1. B summarizes paragraph 2.', type: 'text' },
];
// A long topic, so the page loads in steps and jumps to unloaded questions.
// Every fourth question from the third is true or false, for the type filter.
const practice = Array.from({ length: 34 }, (_, index) => {
  const a = index + 2;
  const truth = index % 4 === 2;
  const question = exampleQuestion(
    `bank-practice-${index + 1}`,
    truth
      ? { correct: a * 3 > 20, type: 'boolean' }
      : { accepted: [String(a * 3)], type: 'short' }
  );
  question.stem = [
    {
      text: `A rectangle has width $${a}$ cm and length $3$ cm.`,
      type: 'text',
    },
  ];
  question.parts[0].blocks = [
    {
      text: truth ? 'Its area is more than 20 cm².' : 'Find its area in cm².',
      type: 'text',
    },
  ];
  question.parts[0].solution = [
    { text: `$${a}\\times 3=${a * 3}$`, type: 'text' },
  ];
  return question;
});
const details = new Map([
  ...samples.map((question, index): [string, BankDetail] => [
    question.id,
    {
      editor: true,
      examLabel: index === 0 ? 'HKDSE' : 'IELTS',
      position: 1,
      question,
      reviewedAt: null,
      reviewedBy: '',
      reviewerName: '',
      sources: [],
      subjectLabel: index === 0 ? 'Mathematics' : 'Academic Reading',
      topicId: index === 0 ? 'mensuration' : 'reading-headings',
      topicLabel: index === 0 ? 'Mensuration' : 'Matching headings',
      updatedAt: new Date().toISOString(),
    },
  ]),
  ...practice.map((question, index): [string, BankDetail] => [
    question.id,
    {
      editor: true,
      examLabel: 'HKDSE',
      position: index + 1,
      question,
      reviewedAt: index % 3 ? null : new Date().toISOString(),
      reviewedBy: '',
      reviewerName: index % 3 ? '' : 'You',
      sources: [],
      subjectLabel: 'Mathematics',
      topicId: 'practice',
      topicLabel: 'Area practice',
      updatedAt: new Date().toISOString(),
    },
  ]),
]);
const topicRows = (id: string): BankRow[] =>
  [...details.values()]
    .filter((detail) => detail.topicId === id)
    .map((detail) => ({
      answerTypes: [
        ...new Set(detail.question.parts.map((part) => part.answer.type)),
      ],
      hasFigure: false,
      hasTable: false,
      id: detail.question.id,
      marks: questionMarks(detail.question),
      position: detail.position,
      preview: detail.question.stem
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' '),
      reviewedAt: detail.reviewedAt,
      reviewerName: detail.reviewerName,
    }));
// The learner's latest score per question and when it was checked, seeded
// so the landing lists a topic to continue and one to summarize.
const answersById = new Map<string, { at: number; score: number }>([
  ['bank-quadratic', { at: Date.now() - 86_400_000, score: 1 }],
  ['bank-practice-2', { at: Date.now() - 3_600_000, score: 1 }],
  ['bank-practice-3', { at: Date.now() - 3_000_000, score: 0 }],
  ['bank-practice-4', { at: Date.now() - 2_400_000, score: 0.5 }],
]);
/** Mirrors the server's progress row for one topic. */
function topicProgress(topicId: string): BankTopicProgress | null {
  const rows = topicRows(topicId);
  const done = rows.flatMap((row, index) => {
    const answer = answersById.get(row.id);
    return answer ? [{ index, ...answer }] : [];
  });
  if (!done.length) return null;
  const last = done.reduce((a, b) => (b.at > a.at ? b : a));
  const next = [...rows.slice(last.index + 1), ...rows].find(
    (row) => !answersById.has(row.id)
  );
  const detail = details.get(rows[0].id) as BankDetail;
  return {
    answered: done.length,
    correct: done.filter((answer) => answer.score >= 1).length,
    examId: detail.examLabel.toLowerCase(),
    examLabel: detail.examLabel,
    lastAnsweredAt: new Date(last.at).toISOString(),
    nextQuestionId: next?.id ?? null,
    subjectId: detail.subjectLabel.toLowerCase(),
    subjectLabel: detail.subjectLabel,
    topicId,
    topicLabel: detail.topicLabel,
    total: rows.length,
  };
}
/** A question as View mode reads it. */
const learnerDetail = (detail: BankDetail): BankDetail => ({
  ...detail,
  question: learnerView(detail.question as Question),
});
const ownerAccess = {
  capabilities: {
    canEdit: true,
    canEditContent: true,
    canManageMembers: true,
    canView: true,
  },
  role: 'owner' as const,
};
export const questionBankHandlers = [
  http.get('/api/bank/syllabus', () => {
    const syllabus: BankSyllabus = {
      assetsUrl,
      editor: true,
      exams: [
        {
          id: 'hkdse',
          label: 'HKDSE',
          subjects: [
            {
              id: 'mathematics',
              label: 'Mathematics',
              topics: [
                {
                  id: 'mensuration',
                  label: 'Mensuration',
                  reviewed: topicRows('mensuration').filter(
                    (row) => row.reviewedAt
                  ).length,
                  total: 1,
                },
                {
                  id: 'practice',
                  label: 'Area practice',
                  reviewed: topicRows('practice').filter(
                    (row) => row.reviewedAt
                  ).length,
                  total: practice.length,
                },
              ],
            },
          ],
        },
        {
          id: 'ielts',
          label: 'IELTS',
          subjects: [
            {
              id: 'reading',
              label: 'Academic Reading',
              topics: [
                {
                  id: 'reading-headings',
                  label: 'Matching headings',
                  reviewed: topicRows('reading-headings').filter(
                    (row) => row.reviewedAt
                  ).length,
                  total: 1,
                },
              ],
            },
          ],
        },
      ],
    };
    return HttpResponse.json(syllabus);
  }),
  http.get('/api/bank/topics/:topicId/questions', ({ params }) =>
    HttpResponse.json({ questions: topicRows(String(params.topicId)) })
  ),
  // View mode reads, answer-free for editors too.
  http.get('/api/bank/questions', async ({ request }) => {
    const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
    const found = ids.flatMap((id) => details.get(id) ?? []);
    // A short delay makes the loading steps visible in dev.
    await delay(400);
    return found.length === ids.length
      ? HttpResponse.json({ questions: found.map(learnerDetail) })
      : new HttpResponse(null, { status: 404 });
  }),
  http.get('/api/bank/questions/:id', ({ params }) => {
    const detail = details.get(String(params.id));
    return detail
      ? HttpResponse.json(learnerDetail(detail))
      : new HttpResponse(null, { status: 404 });
  }),
  // Edit mode's read, with the key, for editors only.
  http.get('/api/bank/questions/:id/edit', ({ params }) => {
    const detail = details.get(String(params.id));
    return detail?.editor
      ? HttpResponse.json(detail)
      : new HttpResponse(null, { status: 404 });
  }),
  http.put('/api/bank/questions/:id', async ({ params, request }) => {
    const detail = details.get(String(params.id));
    if (!detail) return new HttpResponse(null, { status: 404 });
    const body = (await request.json()) as {
      question: unknown;
      updatedAt: string;
    };
    if (body.updatedAt !== detail.updatedAt)
      return HttpResponse.json(
        { message: 'This question changed. Reopen it before saving.' },
        { status: 409 }
      );
    try {
      const question = validateQuestion(body.question, {
        bank: true,
        bankAssetsUrl: assetsUrl,
      });
      if (question.id !== params.id)
        throw new Error('Question identity changed.');
      detail.question = question;
      detail.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(detail.updatedAt) + 1)
      ).toISOString();
      return HttpResponse.json(detail);
    } catch (error) {
      return HttpResponse.json(
        {
          message: error instanceof Error ? error.message : 'Invalid question',
        },
        { status: 422 }
      );
    }
  }),
  http.put('/api/bank/questions/:id/review', async ({ params, request }) => {
    const detail = details.get(String(params.id));
    if (!detail) return new HttpResponse(null, { status: 404 });
    const { reviewed } = (await request.json()) as { reviewed: boolean };
    detail.reviewedAt = reviewed ? new Date().toISOString() : null;
    detail.reviewerName = reviewed ? 'You' : '';
    return HttpResponse.json(detail);
  }),
  // Grades the answers, keeps the latest score and returns the key.
  http.post('/api/bank/questions/:id/check', async ({ params, request }) => {
    const id = String(params.id);
    const detail = details.get(id);
    if (!detail) return new HttpResponse(null, { status: 404 });
    const { answers } = (await request.json()) as { answers: Answers };
    if (typeof answers !== 'object' || answers === null)
      return new HttpResponse(null, { status: 422 });
    const graded = gradeQuestions([detail.question as Question], answers);
    answersById.set(id, {
      at: Date.now(),
      score: graded.awarded / graded.max,
    });
    return HttpResponse.json({
      correct: graded.awarded,
      question: graded.questions[0],
      total: graded.max,
    });
  }),
  http.get('/api/bank/topics/:topicId/marks', ({ params }) => {
    const body: BankTopicMarks = {
      marks: Object.fromEntries(
        topicRows(String(params.topicId)).flatMap((row) => {
          const answer = answersById.get(row.id);
          return answer ? [[row.id, answer.score]] : [];
        })
      ),
    };
    return HttpResponse.json(body);
  }),
  http.get('/api/bank/progress', () => {
    const topics = ['mensuration', 'practice', 'reading-headings']
      .flatMap((id) => topicProgress(id) ?? [])
      .sort((a, b) => b.lastAnsweredAt.localeCompare(a.lastAnsweredAt));
    return HttpResponse.json({ topics });
  }),
  // Copies into a new quiz or the end of one in a workspace the user edits.
  http.post('/api/bank/copy', async ({ request }) => {
    const body = (await request.json()) as BankCopyReq;
    const name = body.quizName?.trim() ?? '';
    const chapterName = body.chapterName?.trim() ?? '';
    const found = body.questionIds.flatMap((id) => details.get(id) ?? []);
    if (
      !body.questionIds.length ||
      body.questionIds.length > 20 ||
      !name === !body.quizId ||
      ((body.chapterId || chapterName) && body.quizId) ||
      (body.chapterId && chapterName)
    )
      return new HttpResponse(null, { status: 422 });
    if (found.length !== body.questionIds.length)
      return new HttpResponse(null, { status: 404 });
    const ws = db.workspaces.find((item) => item.id === body.workspaceId);
    if (!ws?.capabilities.canEdit)
      return new HttpResponse(null, { status: 403 });
    const copies = found.map((detail) => ({
      ...structuredClone(detail.question as Question),
      id: uid('q'),
    }));
    let quizId = body.quizId ?? '';
    if (quizId) {
      const quiz = db.materials.find(
        (item) =>
          item.id === quizId &&
          item.kind === 'quiz' &&
          item.workspaceId === ws.id
      );
      if (!quiz) return new HttpResponse(null, { status: 404 });
      const questions = [...db.quizFromMaterial(quiz).questions, ...copies];
      quiz.content = createMaterialDocument([quizNode({ questions }, quiz.id)]);
      quiz.revision += 1;
      db.refreshMaterialContentBytes(quiz);
    } else {
      // A typed chapter is reused in any case or created, as the server does.
      let chapterId = body.chapterId ?? null;
      if (chapterName) {
        const existing = db.chapters.find(
          (chapter) =>
            chapter.workspaceId === ws.id &&
            chapter.name.toLowerCase() === chapterName.toLowerCase()
        );
        chapterId = existing?.id ?? uid('ch');
        if (!existing) {
          db.chapters.push({
            fileIds: [],
            id: chapterId,
            name: chapterName,
            order: db.chapters.filter(
              (chapter) => chapter.workspaceId === ws.id
            ).length,
            workspaceId: ws.id,
          });
          ws.chapterCount += 1;
        }
      }
      quizId = uid('qz');
      db.materials.unshift(
        db.makeMaterial({
          ...ownerAccess,
          chapterId,
          content: createMaterialDocument([
            quizNode({ questions: copies }, uid('quiz')),
          ]),
          createdAt: new Date().toISOString(),
          id: quizId,
          kind: 'quiz',
          privacy: 'private',
          scopeChapters: [],
          scopeFileNames: [],
          title: name,
          workspaceId: ws.id,
          workspaceName: ws.name,
        })
      );
    }
    return HttpResponse.json({ quizId, workspaceId: ws.id });
  }),
  http.post(
    '/api/bank/questions/:id/comments',
    () => new HttpResponse(null, { status: 204 })
  ),
  http.post('/api/bank/assets', async ({ request }) => {
    const file = (await request.formData()).get('file');
    if (!(file instanceof File)) return new HttpResponse(null, { status: 422 });
    const hash = await crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer()
    );
    const url =
      assetsUrl +
      '/' +
      [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    assets.set(url, file);
    return HttpResponse.json({ url }, { status: 201 });
  }),
  http.get(assetsUrl + '/*', ({ request }) => {
    const file = assets.get(request.url);
    return file
      ? new HttpResponse(file, { headers: { 'Content-Type': file.type } })
      : new HttpResponse(null, { status: 404 });
  }),
];
