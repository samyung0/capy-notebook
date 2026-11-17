import { HttpResponse, http } from 'msw';
import type {
  AssignmentFormReq,
  ItemBank,
  ItemBankQuestion,
  Material,
  Workspace,
} from '@/api/types';
import type { Question } from '@/features/questions/types';
import { addMockGradedQuiz } from './assignments';
import { biologyQuizQuestions } from './biologyQuiz';

/** Item banks (todo-graded-quizzes.md): the caller's own (`me`) and each class
 * workspace's, which its owner and editors reach and anyone else is answered
 * 404, as the gateway does. Seeded from the Biology quiz's questions; a class
 * bank's take its workspace's topics in turn, some none. */
const banks = new Map<string, ItemBankQuestion[]>();
let made = 0;

const seedTags = [
  ['osmosis', 'practical'],
  ['osmosis'],
  ['cells', 'membranes'],
  ['graphs'],
  ['cell division'],
  ['genetics'],
];

const at = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function seeded(
  bank: string,
  count: number,
  topicIds: string[]
): ItemBankQuestion[] {
  return biologyQuizQuestions.slice(0, count).map((question, i) => {
    // Every third has none, every fourth two.
    const own =
      i % 3 === 2
        ? []
        : [topicIds[i % topicIds.length], topicIds[(i + 1) % topicIds.length]]
            .slice(0, i % 4 === 0 ? 2 : 1)
            .filter(Boolean);
    const { topicIds: _seed, ...copy } = structuredClone(question);
    return {
      createdAt: at(i + 1),
      id: `bq_${bank}_${i}`,
      question: { ...copy, ...(own.length > 0 && { topicIds: own }) },
      tags: seedTags[i % seedTags.length],
      updatedAt: at(i + 1),
    };
  });
}

/** The words a bank question's Search reads: its text and answers. */
const searchText = (question: Question) =>
  JSON.stringify([
    question.stem,
    question.groups,
    question.parts,
  ]).toLowerCase();

export const itemBankHandlers = (
  workspace: (
    id: string
  ) => Pick<Workspace, 'kind' | 'name' | 'role'> | undefined,
  /** A workspace's topic ids. */
  topicIdsOf: (workspaceId: string) => string[],
  /** A quiz material in the workspace holding these questions. */
  makeQuiz: (quiz: {
    hidden: boolean;
    questions: Question[];
    title: string;
    workspaceId: string;
  }) => Material,
  /** A quiz material's workspace ('' for none); undefined when not found. */
  quizWorkspace: (quizId: string) => string | undefined
) => {
  const questionsOf = (bank: string) => {
    let list = banks.get(bank);
    if (!list) {
      list =
        bank === 'me' ? seeded(bank, 4, []) : seeded(bank, 8, topicIdsOf(bank));
      banks.set(bank, list);
    }
    return list;
  };
  /** As read: a topic the bank's workspace doesn't hold (any, in My bank)
   * is left out, and the list with it once empty. */
  const read = (bank: string, item: ItemBankQuestion): ItemBankQuestion => {
    const held = bank === 'me' ? [] : topicIdsOf(bank);
    const { topicIds = [], ...question } = item.question;
    const kept = topicIds.filter((id) => held.includes(id));
    return {
      ...item,
      question: kept.length > 0 ? { ...question, topicIds: kept } : question,
    };
  };
  const reaches = (bank: string) => {
    if (bank === 'me') return true;
    const ws = workspace(bank);
    return (
      ws?.kind === 'class' && (ws.role === 'owner' || ws.role === 'editor')
    );
  };
  const notFound = () =>
    HttpResponse.json({ detail: 'not found', status: 404 }, { status: 404 });
  /** Picked questions copied for a quiz in `workspaceId`, fresh ids, in the
   * order picked; undefined when one isn't in the bank. Topics stay only in
   * their class's own workspace. */
  const copies = (bank: string, ids: string[], workspaceId: string) => {
    const list = questionsOf(bank);
    const picked = ids.map((id) => list.find((item) => item.id === id));
    if (picked.some((item) => !item)) return;
    return picked.map((item) => {
      const question = structuredClone(
        read(bank, item as ItemBankQuestion).question
      );
      if (workspaceId !== bank) delete question.topicIds;
      question.id = crypto.randomUUID();
      for (const part of question.parts) part.id = crypto.randomUUID();
      return question;
    });
  };
  return [
    http.get('/api/item-banks', ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      const items: ItemBank[] = [];
      if (workspaceId && reaches(workspaceId))
        items.push({
          count: questionsOf(workspaceId).length,
          id: workspaceId,
          kind: 'workspace',
          name: workspace(workspaceId)?.name ?? '',
        });
      items.push({
        count: questionsOf('me').length,
        id: 'me',
        kind: 'personal',
        name: '',
      });
      return HttpResponse.json({ items });
    }),
    http.get('/api/item-banks/:bank/questions', ({ params, request }) => {
      const bank = String(params.bank);
      if (!reaches(bank)) return notFound();
      const search = new URL(request.url).searchParams;
      const q = search.get('q')?.toLowerCase() ?? '';
      const tags = search.get('tags')?.split(',').filter(Boolean) ?? [];
      const topics = search.get('topics')?.split(',').filter(Boolean) ?? [];
      const matching = questionsOf(bank)
        .map((item) => read(bank, item))
        .filter((item) => !q || searchText(item.question).includes(q))
        .filter(
          (item) => !tags.length || item.tags.some((t) => tags.includes(t))
        )
        .filter(
          (item) =>
            !topics.length ||
            !!item.question.topicIds?.some((id) => topics.includes(id))
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const start = Number(search.get('cursor') || 0);
      const limit = Number(search.get('limit') || 50);
      const end = start + limit;
      return HttpResponse.json({
        items: matching.slice(start, end),
        total: matching.length,
        ...(end < matching.length ? { nextCursor: String(end) } : {}),
      });
    }),
    http.get('/api/item-banks/:bank/tags', ({ params }) => {
      const bank = String(params.bank);
      if (!reaches(bank)) return notFound();
      const tags = [...new Set(questionsOf(bank).flatMap((item) => item.tags))];
      return HttpResponse.json({ tags: tags.sort() });
    }),
    http.post(
      '/api/item-banks/:bank/questions',
      async ({ params, request }) => {
        const bank = String(params.bank);
        if (!reaches(bank)) return notFound();
        const { question, tags } = (await request.json()) as {
          question: Question;
          tags: string[];
        };
        made += 1;
        const now = new Date().toISOString();
        const item: ItemBankQuestion = {
          createdAt: now,
          id: `bq_new_${made}`,
          question,
          tags,
          updatedAt: now,
        };
        questionsOf(bank).unshift(item);
        return HttpResponse.json(read(bank, item), { status: 201 });
      }
    ),
    http.put(
      '/api/item-banks/:bank/questions/:id',
      async ({ params, request }) => {
        const bank = String(params.bank);
        if (!reaches(bank)) return notFound();
        const item = questionsOf(bank).find((row) => row.id === params.id);
        if (!item) return notFound();
        const { question, tags } = (await request.json()) as {
          question: Question;
          tags: string[];
        };
        Object.assign(item, {
          question,
          tags,
          updatedAt: new Date().toISOString(),
        });
        return HttpResponse.json(read(bank, item));
      }
    ),
    // From the bank: copies with fresh ids, in the order picked.
    http.post('/api/item-banks/:bank/quizzes', async ({ params, request }) => {
      const bank = String(params.bank);
      if (!reaches(bank)) return notFound();
      const body = (await request.json()) as {
        gradedQuiz?: AssignmentFormReq;
        questionIds: string[];
        title: string;
        workspaceId: string;
      };
      const questions = copies(bank, body.questionIds, body.workspaceId);
      if (!questions) return notFound();
      const quiz = makeQuiz({
        hidden: true,
        questions,
        title: body.title,
        workspaceId: body.workspaceId,
      });
      if (body.gradedQuiz)
        quiz.assignmentId = addMockGradedQuiz(
          body.workspaceId,
          body.gradedQuiz,
          quiz.id
        );
      return HttpResponse.json(quiz, { status: 201 });
    }),
    // The quiz editor's From the bank: the copies come back to insert.
    http.post(
      '/api/quizzes/:id/bank-questions',
      async ({ params, request }) => {
        const workspaceId = quizWorkspace(String(params.id));
        const body = (await request.json()) as {
          bank: string;
          questionIds: string[];
        };
        if (workspaceId === undefined || !reaches(body.bank)) return notFound();
        const questions = copies(body.bank, body.questionIds, workspaceId);
        if (!questions) return notFound();
        return HttpResponse.json({ questions });
      }
    ),
    http.delete('/api/item-banks/:bank/questions/:id', ({ params }) => {
      const bank = String(params.bank);
      if (!reaches(bank)) return notFound();
      const list = questionsOf(bank);
      const index = list.findIndex((row) => row.id === params.id);
      if (index < 0) return notFound();
      list.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
};
