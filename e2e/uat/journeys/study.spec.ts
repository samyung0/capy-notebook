/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Study progress (openwiki/study-progress.md) on the deployed stack: one
// owner, progress on, and enough steps to prove each record is written. The
// detailed cases (unread, started items, skipping, counts) live in the Docker
// suite, e2e/study/study-progress.spec.ts. The file is store-only and the
// quiz part true/false, which the server grades without Jev, so the journey
// makes no parser, embedding or LLM call.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  api,
  fixture,
  noProviderCalls,
  object,
  string,
  upload,
  workspace,
} from './files';
import { expect, test, type UatRun } from './runtime';

const prompt = 'Wetland plants absorb carbon.';
const front = 'Estuary';

async function material(
  run: UatRun,
  workspaceId: string,
  kind: 'quiz' | 'flashcards',
  title: string,
  value: unknown[]
) {
  const created = object(
    await api(
      run.owner,
      `/api/workspaces/${workspaceId}/materials`,
      'POST',
      { content: { schemaVersion: 1, value }, kind, title },
      201
    )
  );
  return string(created.id);
}

/** A one-question true/false quiz (a closed part, graded on the server). */
function quiz(run: UatRun, workspaceId: string, title: string) {
  return material(run, workspaceId, 'quiz', title, [
    {
      children: [
        {
          children: [{ text: '' }],
          id: 'q_1',
          question: {
            id: 'q_1',
            labels: 'letters',
            layout: 'paper',
            parts: [
              {
                answer: { correct: true, type: 'boolean' },
                blocks: [{ text: prompt, type: 'text' }],
                id: 'q_1:part:1',
                marks: 1,
                solution: [],
              },
            ],
            stem: [],
          },
          type: 'quiz_question',
        },
      ],
      id: 'quiz_root',
      type: 'quiz',
    },
  ]);
}

/** A one-card set; card ids are global keys, so each run mints its own. */
function cards(run: UatRun, workspaceId: string) {
  return material(run, workspaceId, 'flashcards', 'Cards', [
    {
      children: [
        {
          children: [
            { children: [{ text: front }], type: 'flashcard_front' },
            {
              children: [{ text: 'Where a river meets the sea' }],
              type: 'flashcard_back',
            },
          ],
          id: `c_uat_${randomUUID()}`,
          type: 'flashcard',
        },
      ],
      id: 'cards_root',
      type: 'flashcards',
    },
  ]);
}

/** Waits for the response a click causes. */
async function clicked(page: Page, path: string, button: string) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() !== 'GET'
  );
  await page.getByRole('button', { exact: true, name: button }).click();
  return (await response).status();
}

test('study progress: a file read, a quiz finished, a set studied, Continue and a short review are recorded', async ({
  run,
}) => {
  test.setTimeout(600_000);
  const page = run.owner.page;
  const workspaceId = await workspace(run, 'study');
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  const file = await upload(
    run,
    workspaceId,
    'lesson.docx',
    await fixture('lesson.docx', marker),
    true
  );
  const finishedQuiz = await quiz(run, workspaceId, 'Finished quiz');
  const set = await cards(run, workspaceId);
  const nextQuiz = await quiz(run, workspaceId, 'Next quiz');
  const chapter = object(
    await api(
      run.owner,
      `/api/workspaces/${workspaceId}/chapters`,
      'POST',
      { name: 'Week 1' },
      201
    )
  );
  await api(
    run.owner,
    `/api/workspaces/${workspaceId}/content/reorder`,
    'POST',
    {
      chapterId: string(chapter.id),
      items: [
        { id: file, type: 'file' },
        { id: finishedQuiz, type: 'material' },
        { id: set, type: 'material' },
        { id: nextQuiz, type: 'material' },
      ],
    },
    204
  );
  // Progress is on by default (users.study_progress, no workspace override).
  assert.equal(
    object(await api(run.owner, `/api/workspaces/${workspaceId}/study`))
      .enabled,
    true
  );

  // The file read from its Files panel row.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  const row = page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { name: /^lesson\.docx/ });
  await row.locator('xpath=..').hover();
  await row
    .locator('xpath=..')
    .getByRole('button', { name: 'Open menu' })
    .click();
  const marked = page.waitForResponse(
    (r) => r.url().endsWith('/study/items') && r.request().method() === 'PUT'
  );
  await page
    .getByRole('menuitem', { exact: true, name: 'Mark as read' })
    .click();
  assert.equal((await marked).status(), 204);
  await expect(row.getByLabel('Done', { exact: true })).toBeVisible();

  // The quiz finished, the set studied to its end.
  await page.goto(`${run.env.appUrl}/quizzes/${finishedQuiz}/attempt`);
  await page.getByRole('button', { exact: true, name: 'True' }).click();
  assert.equal(
    await clicked(
      page,
      `/api/quizzes/${finishedQuiz}/attempts`,
      'Submit answers'
    ),
    201
  );
  await expect(page.getByRole('button', { name: 'Redo quiz' })).toBeVisible();
  await page.goto(`${run.env.appUrl}/flashcards/${set}`);
  await page.getByRole('button', { name: 'Show answer' }).click();
  assert.equal(await clicked(page, '/api/review/ratings', 'Good'), 204);
  await expect(
    page.getByRole('heading', { name: 'Done for now' })
  ).toBeVisible();

  // Continue opens the first item that is not done: the quiz not yet taken.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Continue' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]material=${nextQuiz}(&|$)`));

  // A review session from the Study tab over the card and the question.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Review' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/learning/review/${workspaceId}\\?from=workspace$`)
  );
  await expect(page.getByText('2 left')).toBeVisible();
  const showAnswer = page.getByRole('button', { name: 'Show answer' });
  const check = page.getByRole('button', { exact: true, name: 'Check' });
  for (let left = 2; left > 0; left--) {
    await expect(page.getByText(`${left} left`)).toBeVisible();
    await expect(showAnswer.or(check)).toBeVisible();
    if (await showAnswer.isVisible()) {
      await showAnswer.click();
      assert.equal(await clicked(page, '/api/review/ratings', 'Good'), 204);
      continue;
    }
    await page.getByRole('button', { exact: true, name: 'True' }).click();
    assert.equal(await clicked(page, '/api/review/check', 'Check'), 200);
    await expect(page.getByText('Your answer')).toBeVisible();
    await page.getByRole('button', { exact: true, name: 'Next' }).click();
  }
  await expect(page.getByText('2 reviewed')).toBeVisible();

  // The deployed database holds each record.
  const materials = [finishedQuiz, set, nextQuiz];
  const progress = await run.query<{ id: string; state: string }>(
    `SELECT coalesce(file_id, material_id) AS id, state FROM study_progress
    WHERE user_id=%s AND workspace_id=%s`,
    [run.owner.id, workspaceId]
  );
  assert.deepEqual(Object.fromEntries(progress.map((r) => [r.id, r.state])), {
    [file]: 'done',
    [finishedQuiz]: 'done',
    [set]: 'done',
  });
  const attempts = await run.query(
    'SELECT material_id,correct,total FROM attempts WHERE user_id=%s AND material_id=ANY(%s::text[])',
    [run.owner.id, materials]
  );
  assert.deepEqual(
    attempts.map((r) => [r.material_id, Number(r.correct), Number(r.total)]),
    [[finishedQuiz, 1, 1]]
  );
  // Rated once while studying, once in the review.
  const states = await run.query(
    'SELECT material_id,reps FROM review_states WHERE user_id=%s AND material_id=ANY(%s::text[])',
    [run.owner.id, materials]
  );
  assert.deepEqual(
    Object.fromEntries(states.map((r) => [r.material_id, Number(r.reps)])),
    { [finishedQuiz]: 2, [set]: 2 }
  );
  await run.attach(`${workspaceId}-study`, { attempts, progress, states });
  await noProviderCalls(run, workspaceId);
});
