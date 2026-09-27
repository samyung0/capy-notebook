import { HttpResponse, http } from 'msw';
import type {
  BankDetail,
  BankRow,
  BankSyllabus,
} from '@/features/questions/bank';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import type { Question } from '@/features/questions/types';
import { questionMarks } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';

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
samples[0].parts[0].markscheme = ['Divides 12 by 4 to obtain a width of 3 cm.'];
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
samples[1].parts[0].markscheme = [
  'Matches paragraph 1 to A and paragraph 2 to B.',
];
samples[1].parts[0].solution = [
  { text: 'A summarizes paragraph 1. B summarizes paragraph 2.', type: 'text' },
];
const details = new Map(
  samples.map((question, index): [string, BankDetail] => [
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
  ])
);
const topicRows = (id: string): BankRow[] =>
  [...details.values()]
    .filter((detail) => detail.topicId === id)
    .map((detail) => ({
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
  http.get('/api/bank/questions/:id', ({ params }) =>
    details.has(String(params.id))
      ? HttpResponse.json(details.get(String(params.id)))
      : new HttpResponse(null, { status: 404 })
  ),
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
