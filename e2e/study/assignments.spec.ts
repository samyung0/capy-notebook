import { randomUUID } from 'node:crypto';
import type {
  Assignment,
  AssignmentAttempt,
  MaterialRef,
} from '../../src/api/types';
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
          answer: { accepted: [], hints: [], type: 'open' },
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

    const quizRes = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: { schemaVersion: 1, value: quizValue('Which makes ATP?') },
          kind: 'quiz',
          title: 'Cells check',
        },
      }
    );
    expect(quizRes.status()).toBe(201);
    const quiz = (await quizRes.json()) as { id: string };

    const res = await ownerApi.post(
      `/api/workspaces/${workspaceId}/assignments`,
      {
        data: {
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
          quizId: quiz.id,
          showAnswers: true,
          shuffle: false,
          title: 'Cells check',
        },
      }
    );
    expect(res.status()).toBe(201);
    const assignment = (await res.json()) as Assignment;
    expect(assignment.manage?.assigned).toBe(1);

    // While it is open the assignee reaches only the assignment, through one row.
    expect((await viewerApi.get(`/api/quizzes/${quiz.id}`)).status()).toBe(404);
    const refs = (await (
      await viewerApi.get(`/api/workspaces/${workspaceId}/materials`)
    ).json()) as MaterialRef[];
    expect(refs.find((ref) => ref.id === quiz.id)?.assignmentId).toBe(
      assignment.id
    );

    // The member answers on their page.
    await viewerPage.goto(`/workspaces/${workspaceId}?study=assignments`);
    // Told once what a class member shares (Epo 2026-11-04).
    await viewerPage
      .getByRole('button', { exact: true, name: m.sharing_notice_ok() })
      .click();
    await viewerPage
      .getByRole('button', { exact: true, name: m.assignment_start() })
      .locator('visible=true')
      .click();
    await viewerPage
      .locator('[data-question-row]')
      .nth(1)
      .waitFor({ state: 'attached' });
    await viewerPage.getByText('Mitochondria').click();
    await viewerPage.locator('[data-question-row]').nth(1).click();
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
    expect(report.answers[0].waiting).toBe(true);
    const attemptId = report.members[0].attemptId as string;

    // Nobody but the owner's side reads a member's report.
    expect(
      (await viewerApi.get(`/api/assignments/${assignment.id}/report`)).status()
    ).toBe(404);

    // The owner marks it on Approve AI marks, and no model marked it first.
    await ownerPage.goto(
      `/workspaces/${workspaceId}?study=assignments&assignment=${assignment.id}&tab=approve`
    );
    await expect(ownerPage.getByText('By osmosis.')).toBeVisible();
    await ownerPage.getByRole('combobox', { name: 'Names osmosis' }).click();
    await ownerPage.getByRole('option', { name: '2 / 2' }).click();
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

    // Closing gives the member the quiz.
    expect(
      (
        await ownerApi.put(`/api/assignments/${assignment.id}/closed`, {
          data: { closed: true },
        })
      ).status()
    ).toBe(200);
    expect((await viewerApi.get(`/api/quizzes/${quiz.id}`)).status()).toBe(200);
  });

  test('a personal workspace has no assignments for anyone', async ({
    ownerApi,
    workspaceFactory,
  }) => {
    const workspace = await workspaceFactory.create({
      name: `Personal ${randomUUID().slice(0, 8)}`,
    });
    expect(
      (
        await ownerApi.get(`/api/workspaces/${workspace.id}/assignments`)
      ).status()
    ).toBe(404);
  });
});
