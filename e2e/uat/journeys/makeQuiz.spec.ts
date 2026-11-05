/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside this test. */
// Make a quiz on a Word file and on a deck (openwiki/agentic-retrieval.md): real files,
// the real Office runtime in the browser, a real map, copy and solve on the extraction
// slot's model. Each paper has two pages (e2e/fixtures/files/make-quiz/README.md):
// page 1 goes through a real run, whose two questions are saved and charged, and page 2
// through a run cancelled at the confirm step, which pays for its map alone. The mock's
// e2e/editor/make-quiz-office.spec.ts proves the browser's part in CI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  continueWhileReading,
  drawnSheets,
  expectRealPages,
  extractPage,
  keepRunRequests,
  makeQuizFromPanel,
  pageSheet,
  QUIZ_PAPERS,
  quizDialog,
  quizPanel,
  sentRuns,
  uploadPaper,
} from '../../helpers/makeQuiz';
import { m } from '../../i18n';
import { billing, MICROS } from './credits';
import {
  api,
  fileRow,
  fixture,
  object,
  processed,
  settledSessions,
  string,
  workspace,
} from './files';
import { sessionCalls } from './models';
import { expect, test, type UatRun } from './runtime';

/** What a saved question costs (fieldlimits.ExtractionQuestionCredits), and the one the
 * prices on screen say. */
const QUESTION_CREDITS = 4;

/** The file an upload in the dialog made, in the run's manifest as `upload` records one. */
async function uploadedFile(run: UatRun, workspaceId: string, name: string) {
  const [session] = await run.poll(
    'the upload made in the dialog',
    () =>
      run.query(
        'SELECT id,file_id FROM upload_sessions WHERE workspace_id=%s AND name=%s AND file_id IS NOT NULL',
        [workspaceId, name]
      ),
    (rows) => rows.length === 1
  );
  const id = string(session.file_id);
  await run.record('file', id, { workspaceId });
  await run.record('upload', string(session.id), { workspaceId });
  const key = string((await fileRow(run, id)).blob_path);
  await run.record('blob', key, { fileId: id });
  await run.record('blob', key, { sourceSha256: (await run.blob(key)).sha256 });
  return id;
}

const readRun = async (run: UatRun, id: string) =>
  object(await api(run.owner, `/api/extractions/${id}`));

/** Follows a run to its next stop, which must be `status`. */
async function runReaches(
  run: UatRun,
  id: string,
  status: 'confirming' | 'done',
  timeout: number
) {
  const read = await run.poll(
    `run ${id} past ${status === 'done' ? 'its copies' : 'its map'}`,
    () => readRun(run, id),
    (row) => row.status !== 'running',
    timeout
  );
  assert.equal(read.status, status, JSON.stringify(read));
  return read;
}

/** The workspace's `nth` Make a quiz run (from 1), its session settled: what it charged
 * and every call it made. The verifier reads no `question_extractions`, so the run comes
 * from the API and its session from `provider_sessions` (surface `generate`). */
async function settledRun(run: UatRun, workspaceId: string, nth: number) {
  const sessions = await settledSessions(
    run,
    `${workspaceId}-make-quiz-${nth}`,
    "provider_sessions p WHERE p.workspace_id=%s AND p.surface='generate'",
    [workspaceId]
  );
  assert.equal(sessions.length, nth);
  const sessionId = string(sessions[nth - 1].id);
  const charges = await run.query(
    'SELECT kind,surface,actor_user_id,credit_micros,units,unit FROM usage_events WHERE reservation_id=%s',
    [sessionId]
  );
  const calls = await sessionCalls(run, sessionId);
  const mapCalls = calls.filter((call) => call.purpose === 'extraction_map');
  const answered = mapCalls.filter((call) => call.status === 'applied');
  assert(answered.length > 0, 'no map call was applied');
  for (const call of answered)
    assert(Number(call.credit_micros) > 0, 'the map is free');
  const mapMicros = mapCalls.reduce(
    (sum, call) => sum + Number(call.credit_micros ?? 0),
    0
  );
  return { calls, charges, mapMicros };
}

/** Used credits moved by exactly `micros`, with nothing still held. */
async function charged(run: UatRun, usedBefore: number, micros: number) {
  const now = await billing(run.owner);
  assert.equal(Number(now.creditsUsedMicros) - usedBefore, micros);
  assert.equal(Number(now.creditsReservedMicros), 0);
}

/** The map found exactly the questions numbered `labels`, and the confirm step says what
 * the run's read says: the questions, their pages, their price and what finding them cost. */
async function questionsOnScreen(
  run: UatRun,
  page: Page,
  id: string,
  labels: number[]
) {
  const read = await runReaches(run, id, 'confirming', 300_000);
  const found = object(read.found);
  const questions = (found.questions as Record<string, unknown>[]).map(object);
  assert.deepEqual(
    questions.map((question) =>
      Number(/\d+/.exec(string(question.label))?.[0])
    ),
    labels,
    JSON.stringify(found)
  );
  assert.equal(found.paperPages, 1);
  assert.equal(found.answerFiles, 0);
  assert.deepEqual(found.unreadAnswers, []);
  const count = questions.length;
  const dialog = quizDialog(page);
  await expect(
    page.getByRole('heading', {
      name:
        count === 1
          ? m.make_quiz_found_one()
          : m.make_quiz_found_title({ count }),
    })
  ).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('listitem')).toHaveCount(count);
  for (const [i, question] of questions.entries()) {
    const row = dialog.getByRole('listitem').nth(i);
    await expect(row).toContainText(string(question.label));
    await expect(row).toContainText(
      m.make_quiz_found_page({ page: Number(question.first) })
    );
  }
  await expect(
    dialog.getByText(
      count === 1
        ? m.make_quiz_price_one({ price: QUESTION_CREDITS })
        : m.make_quiz_price_line({ count, price: QUESTION_CREDITS })
    )
  ).toBeVisible();
  await expect(
    dialog
      .getByText(m.make_quiz_price_total({ count: count * QUESTION_CREDITS }), {
        exact: true,
      })
      .first()
  ).toBeVisible();
  await expect(dialog.getByText(m.make_quiz_charged())).toBeVisible();
  await expect(
    dialog
      .getByText(
        m.make_quiz_price_total({ count: Number(found.chargedCredits) }),
        { exact: true }
      )
      .first()
  ).toBeVisible();
  return found;
}

for (const { format, name } of QUIZ_PAPERS) {
  test(`make a quiz from a ${format}: its pages drawn in the browser, a file still reading, a run saved and a run cancelled`, async ({
    run,
  }) => {
    test.setTimeout(1_800_000);
    const page = run.owner.page;
    await keepRunRequests(page);
    const workspaceId = await workspace(run, `quiz ${format}`);
    const marker = `UAT_${randomUUID().replaceAll('-', '')}`;

    // A file still reading: Continue closes the dialog, and the panel reopens it at the
    // pages. An empty workspace's Dashboard offers only Add file, so its address opens
    // the dialog here.
    await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}?make=files`);
    await uploadPaper(page, name, await fixture(name, marker, 'make-quiz'));
    await continueWhileReading(page, name);
    const fileId = await uploadedFile(run, workspaceId, name);
    await processed(run, fileId, [marker]);
    const [file] = await run.query(
      'SELECT hidden,topic_id FROM files WHERE id=%s',
      [fileId]
    );
    assert.deepEqual(file, { hidden: true, topic_id: null });
    assert.equal(await makeQuizFromPanel(page, 120_000), fileId);

    // The real pages, drawn in the browser; page 1 alone goes to the run.
    const first = await drawnSheets(page, 2);
    expectRealPages(first, format);
    const usedBefore = Number((await billing(run.owner)).creditsUsedMicros);
    const saving = await extractPage(page, 1);
    assert.deepEqual(await sentRuns(page), [
      {
        answers: [],
        paper: [{ fileId, images: [first[0].base64], pages: [1] }],
        title: 'paper',
      },
    ]);

    // The map found page 1's questions and no others, and the price is on screen.
    const foundSaved = await questionsOnScreen(run, page, saving, [1, 2]);
    await quizDialog(page)
      .getByRole('button', { name: m.make_quiz_make() })
      .click();
    await expect(quizDialog(page)).toHaveCount(0);

    // Confirmed, the run saves a hidden quiz with the questions.
    const done = await runReaches(run, saving, 'done', 900_000);
    assert.equal(done.confirmed, 2);
    const quizId = string(done.quizId);
    const report = object(done.report);
    assert.deepEqual(report.missing, []);
    assert.equal(report.answersMissing, undefined);
    assert.equal(report.pages, 1);
    assert.equal((report.recorded as string[]).length, 2);
    const savedRow = quizPanel(page).locator('[data-quiz-run=done]');
    await expect(
      savedRow.getByText(m.make_quiz_panel_questions({ count: 2 }))
    ).toBeVisible({ timeout: 30_000 });
    await savedRow
      .getByRole('button', { name: m.make_quiz_open_quiz() })
      .click();
    await expect(page).toHaveURL(new RegExp(`material=${quizId}`), {
      timeout: 30_000,
    });
    await expect(page.getByTestId('hidden-chip')).toBeVisible();
    await expect(page.locator('[data-question-row]')).toHaveCount(2, {
      timeout: 30_000,
    });
    const [quiz] = await run.query<{
      content: { value: { children: unknown[]; type: string }[] };
      created_by: string;
      hidden: boolean;
      kind: string;
      title: string;
    }>(
      'SELECT kind,title,hidden,created_by,content FROM materials WHERE id=%s',
      [quizId]
    );
    assert.deepEqual(
      [quiz.kind, quiz.title, quiz.hidden, quiz.created_by],
      ['quiz', 'paper', true, run.owner.id]
    );
    const questions = quiz.content.value
      .filter((node) => node.type === 'quiz')
      .flatMap((node) => node.children)
      .map((node) => JSON.stringify(node));
    assert.equal(questions.length, 2);
    assert.match(questions[0], /ferry/i);
    assert.match(questions[0], /\b23\b/);
    assert.match(questions[1], /lighthouse/i);
    assert.match(questions[1], /\b10\b/);
    assert.doesNotMatch(JSON.stringify(quiz.content), /pears/i);

    // 4 credits a saved question on top of the map, and its copy and solve calls free.
    const paid = await settledRun(run, workspaceId, 1);
    assert.equal(foundSaved.chargedCredits, Math.ceil(paid.mapMicros / MICROS));
    const questionMicros = 2 * QUESTION_CREDITS * MICROS;
    assert.deepEqual(
      paid.charges
        .filter((charge) => charge.kind === 'extraction_question')
        .map((charge) => [
          charge.surface,
          charge.actor_user_id,
          Number(charge.credit_micros),
          Number(charge.units),
          charge.unit,
        ]),
      [['generate', run.owner.id, questionMicros, 2, 'question']]
    );
    const free = paid.calls.filter((call) => call.purpose !== 'extraction_map');
    for (const purpose of ['extraction_copy', 'extraction_solve'])
      assert(
        free.some((call) => call.purpose === purpose),
        `no ${purpose}`
      );
    for (const call of free)
      assert.equal(Number(call.credit_micros ?? 0), 0, call.purpose);
    await charged(run, usedBefore, paid.mapMicros + questionMicros);

    // A second run from the Dashboard, on the file already read: Continue goes straight
    // to the pages, and Cancel at the confirm step leaves only the map to pay.
    await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
    await page
      .getByRole('button', { name: m.dashboard_make_quiz() })
      .click({ timeout: 30_000 });
    await quizDialog(page)
      .getByRole('button', { name: m.make_quiz_choose_file() })
      .click();
    await page.getByRole('option', { name }).click();
    await quizDialog(page)
      .getByRole('button', { name: m.action_continue() })
      .click();
    await expect(page).toHaveURL(/make=pages/);
    const second = await drawnSheets(page, 2);
    expectRealPages(second, format);
    const usedAtCancel = Number((await billing(run.owner)).creditsUsedMicros);
    const cancelling = await extractPage(page, 2);
    assert.deepEqual(await sentRuns(page), [
      {
        answers: [],
        paper: [{ fileId, images: [second[1].base64], pages: [2] }],
        title: 'paper 2',
      },
    ]);
    const foundCancelled = await questionsOnScreen(run, page, cancelling, [3]);
    await quizDialog(page)
      .getByRole('button', { name: m.action_cancel() })
      .click();
    // Back to the pages, the pick still on.
    await expect(pageSheet(page, 2)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 30_000,
    });
    const ended = await readRun(run, cancelling);
    assert.deepEqual(
      [ended.status, ended.confirmed, ended.quizId],
      ['cancelled', undefined, undefined]
    );
    const cancelled = await settledRun(run, workspaceId, 2);
    assert.deepEqual(
      [...new Set(cancelled.calls.map((call) => call.purpose))],
      ['extraction_map']
    );
    assert.equal(
      cancelled.charges.filter(
        (charge) => charge.kind === 'extraction_question'
      ).length,
      0
    );
    assert.equal(
      foundCancelled.chargedCredits,
      Math.ceil(cancelled.mapMicros / MICROS)
    );
    await charged(run, usedAtCancel, cancelled.mapMicros);
    assert.deepEqual(
      await run.query(
        "SELECT id FROM materials WHERE workspace_id=%s AND kind='quiz'",
        [workspaceId]
      ),
      [{ id: quizId }]
    );
    await run.attach(`${fileId}-make-quiz`, {
      cancelled: { charges: cancelled.charges, mapMicros: cancelled.mapMicros },
      saved: {
        charges: paid.charges,
        mapMicros: paid.mapMicros,
        report,
      },
    });
  });
}
