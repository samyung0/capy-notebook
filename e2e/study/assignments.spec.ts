import { randomUUID } from 'node:crypto';
import type { Assignment, AssignmentAttempt } from '../../src/api/types';
import { expect, test } from '../fixtures/actors';
import { m } from '../i18n';

// Assignments on the real stack: the frozen copy, the server's clock, marks.
// Each test makes its own class, so nothing leaks between them.

/** A multiple choice and an open part. */
function quizValue(prompt: string) {
  const question = (id: string, part: Record<string, unknown>) => ({
    children: [{ text: '' }],
    id,
    question: {
      id,
      labels: 'letters',
      layout: 'paper',
      parts: [{ id: `${id}:part:1`, solution: [], ...part }],
      stem: [],
    },
    type: 'quiz_question',
  });
  return [
    {
      children: [
        question('q_1', {
          answer: {
            correct: [1],
            options: ['Nucleus', 'Mitochondria'],
            type: 'mcq',
          },
          blocks: [{ text: prompt, type: 'text' }],
          marks: 1,
        }),
        question('q_2', {
          answer: { accepted: [], type: 'open' },
          blocks: [{ text: 'Explain how water enters a cell.', type: 'text' }],
          marks: 2,
          markscheme: [{ marks: 2, text: 'Names osmosis' }],
        }),
      ],
      id: 'quiz_root',
      type: 'quiz',
    },
  ];
}

const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

test.describe('assignments', () => {
  test('a class owner assigns a quiz, a member submits it, and the owner marks the open answer', async ({
    ownerApi,
    ownerPage,
    viewerApi,
    viewerPage,
    workspaceFactory,
  }) => {
    const name = `E2E Class ${randomUUID()}`;
    const { id: workspaceId } = await workspaceFactory.create({ name });
    expect(
      (
        await ownerApi.patch(`/api/workspaces/${workspaceId}`, {
          data: { kind: 'class' },
        })
      ).status()
    ).toBe(200);
    // The viewer joins through the in-app invitation.
    expect(
      (
        await ownerApi.post(`/api/workspaces/${workspaceId}/invites`, {
          data: { identifier: 'viewer@capynotebook.test', role: 'viewer' },
        })
      ).status()
    ).toBe(202);
    const { items } = (await (
      await viewerApi.get('/api/notifications')
    ).json()) as { items: { href?: string; kind: string }[] };
    const invite = items.find(
      (item) =>
        item.kind === 'workspace_invite' && JSON.stringify(item).includes(name)
    );
    const reference = invite?.href?.split('/').at(-1);
    expect(
      (await viewerApi.post(`/api/workspace-invites/${reference}/accept`)).ok()
    ).toBe(true);

    // A graded quiz is made with its own quiz (Epo 2026-11-16), which comes
    // back owned by it.
    const quizRes = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: { schemaVersion: 1, value: quizValue('Which makes ATP?') },
          gradedQuiz: {
            assignAll: true,
            assignees: [],
            attempts: 1,
            draft: false,
            dueAt: inAWeek(),
            files: [],
            kind: 'marked',
            latePenaltyPct: 0,
            marking: 'ai_approve',
            noLate: false,
            showAnswers: 'submitted',
            showGrades: 'automatic',
            shuffle: false,
            title: 'Cells check',
          },
          kind: 'quiz',
          title: 'Cells check',
        },
      }
    );
    expect(quizRes.status()).toBe(201);
    const quiz = (await quizRes.json()) as { assignmentId: string; id: string };
    const assignment = (await (
      await ownerApi.get(`/api/assignments/${quiz.assignmentId}`)
    ).json()) as Assignment;
    expect(assignment.manage?.assigned).toBe(1);

    // The assignee reaches its quiz only through the assignment.
    expect((await viewerApi.get(`/api/quizzes/${quiz.id}`)).status()).toBe(404);
    const listed = (await (
      await viewerApi.get(`/api/workspaces/${workspaceId}/assignments`)
    ).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual([assignment.id]);

    // The member answers on their page. Accept told them what a class member
    // shares, so no notice opens (Epo 2026-11-19). Their To do is To do's
    // table (Epo 2026-11-20): the row opens its details, whose Start quiz
    // opens the quiz, which starts by itself.
    await viewerPage.goto(`/workspaces/${workspaceId}/assignments`);
    await viewerPage
      .getByRole('button', { name: 'Cells check' })
      .locator('visible=true')
      .first()
      .click();
    await viewerPage
      .getByRole('dialog')
      .getByRole('button', { name: m.todo_start_quiz() })
      .click();
    // The question numbers (Epo 2026-11-19): the grid, or a phone's strip.
    const numbers = viewerPage
      .locator('[data-question-number]')
      .locator('visible=true');
    await numbers.nth(1).waitFor();
    await viewerPage.getByText('Mitochondria').click();
    await numbers.nth(1).click();
    await viewerPage.getByRole('textbox').fill('By osmosis.');
    await viewerPage
      .getByRole('button', { name: m.assignment_submit() })
      .click();
    await viewerPage
      .getByRole('button', { name: m.assignment_submit() })
      .last()
      .click();
    // The closed part is marked; the open part waits for the owner.
    await expect(viewerPage.getByText('1 / 1')).toBeVisible();
    await expect(
      viewerPage.getByRole('heading', { name: m.assignment_submitted() })
    ).toBeVisible();

    const report = await (
      await ownerApi.get(`/api/assignments/${assignment.id}/report`)
    ).json();
    expect(report.members[0].waitingAnswers).toBe(1);
    // Every answer is listed (Epo 2026-11-19): the open one alone waits.
    expect(
      report.answers.filter((row: { waiting: boolean }) => row.waiting)
    ).toHaveLength(1);
    const attemptId = report.members[0].attemptId as string;

    // Nobody but the owner's side reads a member's report.
    expect(
      (await viewerApi.get(`/api/assignments/${assignment.id}/report`)).status()
    ).toBe(404);

    // The owner marks it on Approve AI marks, and no model marked it first.
    await ownerPage.goto(
      `/workspaces/${workspaceId}/assignments?assignment=${assignment.id}&tab=grading`
    );
    await expect(ownerPage.getByText('By osmosis.')).toBeVisible();
    // Marks are typed (Epo 2026-11-18).
    await ownerPage.getByRole('textbox', { name: 'Names osmosis' }).fill('2');
    await ownerPage
      .getByRole('button', { exact: true, name: m.assignment_approve() })
      .click();
    await expect
      .poll(async () => {
        const after = (await (
          await viewerApi.get(`/api/assignment-attempts/${attemptId}`)
        ).json()) as AssignmentAttempt;
        return [after.correct, after.waitingAnswers];
      })
      .toEqual([3, 0]);
  });

  test('a personal workspace holds the task its owner sets themself', async ({
    ownerApi,
    workspaceFactory,
  }) => {
    const workspace = await workspaceFactory.create({
      name: `Personal ${randomUUID().slice(0, 8)}`,
    });
    const me = (await (await ownerApi.get('/api/me')).json()) as { id: string };
    expect(
      (
        await ownerApi.post(`/api/workspaces/${workspace.id}/assignments`, {
          data: {
            assignAll: false,
            assignees: [me.id],
            attempts: 1,
            draft: false,
            files: [],
            kind: 'unmarked',
            latePenaltyPct: 0,
            marking: 'ai_approve',
            noLate: false,
            showAnswers: 'closed',
            showGrades: 'automatic',
            shuffle: false,
            title: 'Read chapter 4',
          },
        })
      ).status()
    ).toBe(201);
    const list = (await (
      await ownerApi.get(`/api/workspaces/${workspace.id}/assignments`)
    ).json()) as { items: { own: boolean; title: string }[] };
    expect(list.items.map((a) => [a.title, a.own])).toEqual([
      ['Read chapter 4', true],
    ]);
  });
});
