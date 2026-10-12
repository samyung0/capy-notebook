import { randomUUID } from 'node:crypto';
import { expect, test } from '../fixtures/actors';
import { m } from '../i18n';

const question = (id: string, text: string, answer: object) => ({
  id,
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer,
      blocks: [{ text, type: 'text' }],
      id: `${id}-part`,
      marks: 1,
      solution: [],
    },
  ],
  stem: [],
});

// Quizzes edit live (Epo 2026-10-10): an editor's change reaches another
// editor and a learner taking the quiz as it is made, an incomplete question
// says what it lacks and leaves the projection, and the learner never holds
// the answer key.
test('editors edit a quiz together and a learner follows it live', async ({
  editorPage,
  ownerApi,
  ownerPage,
  seed,
  viewerApi,
  viewerPage,
}) => {
  const created = await ownerApi.post('/api/quizzes', {
    data: {
      name: `E2E Live Quiz ${randomUUID()}`,
      questions: [
        question('lq1', 'Which organelle makes ATP?', {
          correct: [1],
          options: ['Nucleus', 'Mitochondria'],
          type: 'mcq',
        }),
        question('lq2', 'Cells have membranes.', {
          correct: true,
          type: 'boolean',
        }),
      ],
      workspaceId: seed.privateWorkspace.id,
    },
  });
  expect(created.status()).toBe(201);
  const quizId = ((await created.json()) as { id: string }).id;

  await Promise.all([
    ownerPage.goto(`/materials/${quizId}?mode=edit`),
    editorPage.goto(`/materials/${quizId}?mode=edit`),
    viewerPage.goto(`/quizzes/${quizId}/attempt`),
  ]);
  for (const page of [ownerPage, editorPage, viewerPage])
    await expect(page.getByText('Mitochondria', { exact: true })).toBeVisible();

  await ownerPage
    .getByRole('button', { exact: true, name: m.action_edit() })
    .first()
    .click();
  const dialog = ownerPage.getByRole('dialog');
  await dialog
    .getByRole('button', { name: m.question_ui_answer_and_marks() })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: m.question_ui_option_number({ number: 2 }) })
    .fill('Mitochondrion');

  // The other editor and the learner see the option change as it is made.
  await expect(
    editorPage.getByText('Mitochondrion', { exact: true })
  ).toBeVisible();
  await expect(
    viewerPage.getByText('Mitochondrion', { exact: true })
  ).toBeVisible();

  // Removing the correct option leaves the question incomplete: a line under
  // it says what it lacks, and the projection leaves it out.
  await dialog
    .getByRole('button', {
      name: m.question_ui_remove_option({ number: 2 }),
    })
    .click();
  await expect(
    editorPage.getByText(
      m.quiz_incomplete({ reason: m.quiz_incomplete_correct() })
    )
  ).toBeVisible();
  await expect(
    viewerPage.getByText('Mitochondrion', { exact: true })
  ).toHaveCount(0);
  // A learner read projects a lagging room first.
  await expect
    .poll(
      async () => {
        const response = await ownerApi.get(`/api/quizzes/${quizId}`);
        const body = (await response.json()) as {
          questions: { id: string }[];
        };
        return body.questions.map((q) => q.id);
      },
      { timeout: 30_000 }
    )
    .toEqual(['lq2']);

  // The learner's reads never carried a key.
  const read = await viewerApi.get(`/api/quizzes/${quizId}`);
  expect(await read.text()).not.toContain('"correct"');
  await ownerPage.keyboard.press('Escape');
  await ownerApi.delete(`/api/quizzes/${quizId}`);
});
