import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/**
 * A quiz embedded in a BlockSuite note (todo-blocksuite-spike.md, step 1
 * piece 4): the `capy:material-ref` block shows the app's quiz editor as a
 * React island, which edits the quiz through the quiz's own item room. Runs
 * only with the flag on:
 * `VITE_DOCUMENT_LAYOUT=blocks pnpm e2e:msw:editor blocksuite-embed`.
 */

// biome-ignore lint/suspicious/noSkippedTests: BlockSuite notes exist only on a blocks-layout stack.
test.skip(
  process.env.VITE_DOCUMENT_LAYOUT !== 'blocks',
  'needs VITE_DOCUMENT_LAYOUT=blocks'
);

const COLLABORATION = '/src/mocks/collaboration.ts';
const LIVE_QUIZ = '/src/features/quizzes/liveQuiz.ts';
// The first of the seeded lecture note's embedded quizzes.
const NOTE = 'mat_note_1';
const QUIZ = 'mat_embed_bio_note_cell_types';

/** Another participant of the quiz's content room, headless, on
 * `window.quizPeer`. */
async function joinQuizPeer(page: Page) {
  const join = () =>
    page.evaluate(
      async ({ path, quiz }) => {
        const { join, rooms } = (await import(
          path
        )) as typeof import('../../src/mocks/collaboration');
        const room = [...rooms.values()].find(
          (room) => room.target.id === quiz && !room.name.startsWith('keys:')
        );
        if (!room) return false;
        const Doc = room.document.constructor as new () => typeof room.document;
        const document = new Doc();
        join(room, { document, origin: {} });
        Object.assign(window, { quizPeer: document });
        return true;
      },
      { path: COLLABORATION, quiz: QUIZ }
    );
  // The room exists once the embed joined it.
  await expect.poll(join).toBe(true);
}

/** The quiz's question ids as the peer holds them. */
const peerQuestions = (page: Page) =>
  page.evaluate(async (path) => {
    const { readQuestions } = (await import(
      path
    )) as typeof import('../../src/features/quizzes/liveQuiz');
    const { quizPeer } = window as unknown as { quizPeer: import('yjs').Doc };
    return readQuestions(quizPeer, null).map(({ id }) => id);
  }, LIVE_QUIZ);

test('a quiz ref shows its quiz, and edits in it reach the quiz room', async ({
  page,
}) => {
  // The first spec of the run pays for transforming BlockSuite's sources.
  test.setTimeout(150_000);
  await page.goto(`/workspaces/ws_bio?material=${NOTE}&mode=edit`);
  const note = page.locator('[data-blocksuite-note]');
  // The note's first ref; its quiz's rooms join once it nears the screen.
  const quiz = note.locator('[data-capy-material-ref]').first();
  await expect(quiz).toBeAttached({ timeout: 90_000 });
  await quiz.scrollIntoViewIfNeeded();
  await expect(
    quiz.getByRole('button', { name: m.quiz_add_question() })
  ).toBeVisible();
  await expect(quiz).toContainText(
    'Which of these is found in prokaryotic cells?'
  );
  await expect(quiz).toContainText('Bacteria are eukaryotes.');

  await joinQuizPeer(page);
  await expect.poll(() => peerQuestions(page)).toHaveLength(3);
  const [, second] = await peerQuestions(page);

  await quiz.getByRole('button', { name: m.action_remove() }).nth(1).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: m.action_remove() })
    .click();
  await expect(quiz).not.toContainText('Bacteria are eukaryotes.');
  await expect.poll(() => peerQuestions(page)).not.toContain(second);
  expect(await peerQuestions(page)).toHaveLength(2);
  // The note keeps its block: only the quiz changed.
  await expect(note.locator('[data-capy-material-ref]')).toHaveCount(4);
});
