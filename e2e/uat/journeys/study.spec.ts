/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Study progress (openwiki/study-progress.md): one owner, one workspace with
// progress on. Files are store-only and every quiz part is true/false, which
// the server grades without Jev, so the journey makes no parser, embedding or
// LLM call. Content is created through the app's API; reading, marking,
// answering, rating and reviewing happen in the browser.
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

type Progress = {
  file_id: string | null;
  material_id: string | null;
  state: string;
};

/** A workspace quiz of true/false questions (closed parts, graded on the server). */
async function quiz(
  run: UatRun,
  workspaceId: string,
  title: string,
  questions: Array<{ prompt: string; correct: boolean }>
) {
  const value = [
    {
      children: questions.map(({ prompt, correct }, index) => {
        const id = `q_${index + 1}`;
        return {
          children: [{ text: '' }],
          id,
          question: {
            id,
            labels: 'letters',
            layout: 'paper',
            parts: [
              {
                answer: { correct, type: 'boolean' },
                blocks: [{ text: prompt, type: 'text' }],
                id: `${id}:part:1`,
                marks: 1,
                solution: [],
              },
            ],
            stem: [],
          },
          type: 'quiz_question',
        };
      }),
      id: 'quiz_root',
      type: 'quiz',
    },
  ];
  return material(run, workspaceId, 'quiz', title, value);
}

/** A flashcard set; card ids are global keys, so each run mints its own. */
async function cards(
  run: UatRun,
  workspaceId: string,
  title: string,
  faces: Array<[string, string]>
) {
  const value = [
    {
      children: faces.map(([front, back]) => ({
        children: [
          { children: [{ text: front }], type: 'flashcard_front' },
          { children: [{ text: back }], type: 'flashcard_back' },
        ],
        id: `c_uat_${randomUUID()}`,
        type: 'flashcard',
      })),
      id: 'cards_root',
      type: 'flashcards',
    },
  ];
  return material(run, workspaceId, 'flashcards', title, value);
}

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

async function chapter(
  run: UatRun,
  workspaceId: string,
  name: string,
  items: Array<{ id: string; type: 'file' | 'material' }>
) {
  const created = object(
    await api(
      run.owner,
      `/api/workspaces/${workspaceId}/chapters`,
      'POST',
      { name },
      201
    )
  );
  await api(
    run.owner,
    `/api/workspaces/${workspaceId}/content/reorder`,
    'POST',
    { chapterId: string(created.id), items },
    204
  );
}

/** The Files panel row's ⋮ menu item (the row link's name is the title plus its mark). */
async function rowMenu(page: Page, name: string, item: string) {
  const link = page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
  const row = link.locator('xpath=..');
  await row.hover();
  const marked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/study/items') &&
      response.request().method() === 'PUT'
  );
  await row.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('menuitem', { exact: true, name: item }).click();
  assert.equal((await marked).status(), 204);
  return link;
}

/** Waits for the rating the click posts. */
async function rate(page: Page, button: string) {
  const rated = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/review/ratings') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { exact: true, name: button }).click();
  assert.equal((await rated).status(), 204);
}

async function progress(run: UatRun, workspaceId: string) {
  return run.query<Progress>(
    'SELECT file_id,material_id,state FROM study_progress WHERE user_id=%s AND workspace_id=%s',
    [run.owner.id, workspaceId]
  );
}

function stateOf(rows: Progress[], id: string) {
  return rows.find((row) => row.file_id === id || row.material_id === id)
    ?.state;
}

test('study progress: read and unread files, started and finished quizzes and sets, Continue, review and Learning', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  const page = run.owner.page;
  const workspaceId = await workspace(run, 'study');
  const marker = `UAT_${randomUUID().replaceAll('-', '')}`;
  const readFile = await upload(
    run,
    workspaceId,
    'lesson.docx',
    await fixture('lesson.docx', marker),
    true
  );
  const unreadFile = await upload(
    run,
    workspaceId,
    'grades.xlsx',
    await fixture('grades.xlsx', marker),
    true
  );
  const questions = [
    { correct: true, prompt: 'Wetland plants absorb carbon.' },
    { correct: false, prompt: 'Mangroves grow only in fresh water.' },
  ];
  const finishedQuiz = await quiz(run, workspaceId, 'Finished quiz', questions);
  const startedQuiz = await quiz(run, workspaceId, 'Started quiz', questions);
  const faces: Array<[string, string]> = [
    ['Estuary', 'Where a river meets the sea'],
    ['Salt marsh', 'Coastal grassland flooded by tides'],
  ];
  const finishedSet = await cards(run, workspaceId, 'Finished cards', faces);
  const startedSet = await cards(run, workspaceId, 'Started cards', faces);
  const materials = [finishedQuiz, startedQuiz, finishedSet, startedSet];
  // Reading order: Week 1's items are all finished by the steps below,
  // Week 2 holds the unread file and the two unfinished materials.
  await chapter(run, workspaceId, 'Week 1', [
    { id: readFile, type: 'file' },
    { id: finishedQuiz, type: 'material' },
    { id: finishedSet, type: 'material' },
  ]);
  await chapter(run, workspaceId, 'Week 2', [
    { id: unreadFile, type: 'file' },
    { id: startedQuiz, type: 'material' },
    { id: startedSet, type: 'material' },
  ]);
  // Progress is on by default (users.study_progress, no workspace override).
  assert.equal(
    object(await api(run.owner, `/api/workspaces/${workspaceId}/study`))
      .enabled,
    true
  );

  // Files panel: one file read, the other read and then unread again.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  const readRow = await rowMenu(page, 'lesson.docx', 'Mark as read');
  await expect(readRow.getByLabel('Done', { exact: true })).toBeVisible();
  const unreadRow = await rowMenu(page, 'grades.xlsx', 'Mark as read');
  await expect(unreadRow.getByLabel('Done', { exact: true })).toBeVisible();
  await rowMenu(page, 'grades.xlsx', 'Mark as unread');
  await expect(unreadRow.getByLabel('Done', { exact: true })).toHaveCount(0);

  // A quiz answered in part and left: nothing reaches the server.
  await page.goto(`${run.env.appUrl}/quizzes/${startedQuiz}/attempt`);
  await page.getByRole('button', { exact: true, name: 'True' }).first().click();
  await expect(page.getByText('1 of 2 answered')).toBeVisible();
  // Another quiz finished: one right, one wrong.
  await page.goto(`${run.env.appUrl}/quizzes/${finishedQuiz}/attempt`);
  const trueButtons = page.getByRole('button', { exact: true, name: 'True' });
  await trueButtons.nth(0).click();
  await trueButtons.nth(1).click();
  await expect(page.getByText('2 of 2 answered')).toBeVisible();
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/quizzes/${finishedQuiz}/attempts`) &&
      response.request().method() === 'POST'
  );
  await page
    .getByRole('button', { exact: true, name: 'Submit answers' })
    .click();
  assert.equal((await submitted).status(), 201);
  await expect(page.getByRole('button', { name: 'Redo quiz' })).toBeVisible();

  // A set studied to the end, and another left after its first card.
  await page.goto(`${run.env.appUrl}/flashcards/${finishedSet}`);
  for (const _ of faces) {
    await page.getByRole('button', { name: 'Show answer' }).click();
    await rate(page, 'Good');
  }
  await expect(
    page.getByRole('heading', { name: 'Done for now' })
  ).toBeVisible();
  await page.goto(`${run.env.appUrl}/flashcards/${startedSet}`);
  await page.getByRole('button', { name: 'Show answer' }).click();
  await rate(page, 'Good');

  const marked = await progress(run, workspaceId);
  assert.equal(stateOf(marked, readFile), 'done');
  assert.equal(stateOf(marked, unreadFile), undefined);
  assert.equal(stateOf(marked, finishedQuiz), 'done');
  assert.equal(stateOf(marked, startedQuiz), undefined);
  assert.equal(stateOf(marked, finishedSet), 'done');
  assert.equal(stateOf(marked, startedSet), 'started');
  const attempts = await run.query(
    'SELECT material_id,correct,total FROM attempts WHERE user_id=%s AND material_id=ANY(%s::text[])',
    [run.owner.id, materials]
  );
  assert.deepEqual(
    attempts.map((row) => [
      row.material_id,
      Number(row.correct),
      Number(row.total),
    ]),
    [[finishedQuiz, 1, 2]]
  );
  const states = async () =>
    run.query(
      `SELECT material_id,item_id,reps,lapses FROM review_states
      WHERE user_id=%s AND material_id=ANY(%s::text[]) ORDER BY material_id,item_id`,
      [run.owner.id, materials]
    );
  const rated = await states();
  const count = (id: string) =>
    rated.filter((row) => row.material_id === id).length;
  // The attempt rated both questions (the wrong one as a lapse); the started
  // set has its one rated card, the started quiz nothing.
  assert.equal(count(finishedQuiz), 2);
  assert.equal(count(startedQuiz), 0);
  assert.equal(count(finishedSet), 2);
  assert.equal(count(startedSet), 1);
  assert(rated.every((row) => Number(row.reps) === 1));
  assert.equal(
    rated
      .filter((row) => Number(row.lapses) > 0)
      .map((row) => row.material_id)
      .join(),
    finishedQuiz
  );
  await run.attach(`${workspaceId}-study-before-review`, {
    attempts,
    marked,
    rated,
  });

  // Continue opens the first item in reading order that is neither done nor
  // removed: the unread file, then (once it is read) the started quiz.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  const continueButton = page.getByRole('button', {
    exact: true,
    name: 'Continue',
  });
  await continueButton.click();
  await expect(page).toHaveURL(new RegExp(`[?&]file=${unreadFile}(&|$)`));
  const header = page.getByTestId('content-header');
  const read = page.waitForResponse(
    (response) =>
      response.url().endsWith('/study/items') &&
      response.request().method() === 'PUT'
  );
  await header.getByRole('button', { name: 'Mark as read' }).click();
  assert.equal((await read).status(), 204);
  await expect(
    header.getByRole('button', { name: 'Mark as unread' })
  ).toBeVisible();
  await continueButton.click();
  await expect(page).toHaveURL(new RegExp(`[?&]material=${startedQuiz}(&|$)`));

  // Review from the Study tab: every rated item, least retained first. Cards
  // take Good, questions are answered True and checked on the server.
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page.getByRole('button', { exact: true, name: 'Review' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/learning/review/${workspaceId}\\?from=workspace$`)
  );
  const showAnswer = page.getByRole('button', { name: 'Show answer' });
  const check = page.getByRole('button', { exact: true, name: 'Check' });
  let checks = 0;
  for (let left = 5; left > 0; left--) {
    await expect(page.getByText(`${left} left`)).toBeVisible();
    await expect(showAnswer.or(check)).toBeVisible();
    if (await showAnswer.isVisible()) {
      await showAnswer.click();
      await rate(page, 'Good');
      continue;
    }
    await page.getByRole('button', { exact: true, name: 'True' }).click();
    const checked = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/review/check') &&
        response.request().method() === 'POST'
    );
    await check.click();
    assert.equal((await checked).status(), 200);
    checks++;
    await expect(page.getByText('Your answer')).toBeVisible();
    await page.getByRole('button', { exact: true, name: 'Next' }).click();
  }
  assert.equal(checks, 2);
  await expect(page.getByText('5 reviewed')).toBeVisible();
  const reviewed = await states();
  assert.equal(reviewed.length, rated.length);
  assert(reviewed.every((row) => Number(row.reps) === 2));
  const logged = await run.query(
    'SELECT count(*)::int AS ratings FROM review_log WHERE user_id=%s AND material_id=ANY(%s::text[])',
    [run.owner.id, materials]
  );
  assert.equal(logged[0]?.ratings, 10);
  // Reviewing finishes nothing new: the started set still lacks a card.
  const after = await progress(run, workspaceId);
  assert.equal(stateOf(after, startedSet), 'started');
  assert.equal(stateOf(after, unreadFile), 'done');
  assert.equal(stateOf(after, startedQuiz), undefined);
  await run.attach(`${workspaceId}-study-after-review`, { after, reviewed });
  await page.getByRole('button', { exact: true, name: 'Done' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));

  // Learning → Review: five reviewable items and 4 of 6 done (two files,
  // four materials; done: both files, the finished quiz and set).
  const [{ name }] = await run.query<{ name: string }>(
    'SELECT name FROM workspaces WHERE id=%s',
    [workspaceId]
  );
  await page.goto(`${run.env.appUrl}/learning`);
  const row = page
    .getByText(name, { exact: true })
    .locator('xpath=ancestor::div[.//button[normalize-space()="Review"]][1]');
  await expect(row.getByText('5', { exact: true })).toBeVisible();
  await expect(row.getByText('4 of 6', { exact: true })).toBeVisible();
  await row.getByRole('button', { exact: true, name: 'Review' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/learning/review/${workspaceId}\\?from=learning$`)
  );
  await expect(page.getByText('5 left')).toBeVisible();
  await noProviderCalls(run, workspaceId);
});
