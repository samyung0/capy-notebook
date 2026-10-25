import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError, parseErrorBody } from '@/api/client';
import type { AnonymousEmbed, AnonymousQuiz } from '@/api/types';
import { getLocale, m } from '@/i18n';

/* A shared quiz's and an embedded quiz's Turnstile slot renders under the
   Check that asked for a token, with the hint hidden until Cloudflare shows a
   challenge; a captcha refusal shows under that Check too (Q372). */

// The locale resolves before a window exists; then linkedom's document goes
// in before react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const refusal = () =>
  new ApiError(
    403,
    'Forbidden',
    'captcha failed',
    parseErrorBody({ errors: [{ message: 'captcha_failed' }] })
  );
const anonymous = vi.hoisted(() => ({
  gradeAnonymousNoteQuiz: vi.fn(),
  gradeAnonymousQuiz: vi.fn(),
}));
vi.mock('@/api/anonymous', async (importActual) => ({
  ...(await importActual<typeof import('@/api/anonymous')>()),
  ...anonymous,
}));
vi.mock('./session', () => ({
  sessionNow: () => false,
  signedIn: async () => false,
  useSignedIn: () => false,
}));
vi.mock('./turnstile', () => ({
  challengeSlot: () => null,
  onChallenge: () => () => {},
  takeTurnstileToken: async () => 'turnstile-token',
}));
vi.mock('@/lib/localDb', () => ({
  anonymousId: async () => 'local-1',
  localQuizAttempts: async () => [],
  saveLocalQuizAttempt: async () => {},
}));

const { createRoot } = await import('react-dom/client');
const { PublicQuizEmbed } = await import('./PublicQuizEmbed');
const { SharedQuiz } = await import('./SharedQuiz');

const question = (id: string) => ({
  id,
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { type: 'boolean' },
      blocks: [{ text: 'True?', type: 'text' }],
      id: `${id}:part:1`,
      marks: 1,
    },
  ],
  stem: [],
});
const questions = [
  question('q1'),
  question('q2'),
] as AnonymousQuiz['questions'];

/** Renders `page`, clicks its second Check and reports where the Turnstile
 * slot and the refusal landed. */
async function checkSecond(page: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        {page}
      </QueryClientProvider>
    );
  });
  const slotBefore = host.querySelector('[data-turnstile-check]');
  const checks = [...host.querySelectorAll('button')].filter(
    (button) => button.textContent === m.question_ui_check()
  );
  await act(async () => {
    checks[1]?.click();
  });
  const slot = host.querySelector('[data-turnstile-check]');
  const seen = {
    checks: checks.length,
    hintHidden: slot?.querySelector('p')?.hasAttribute('hidden'),
    refusal: slot?.nextElementSibling?.textContent,
    slotBefore,
    // Right after the second Check, inside that question's row.
    slotUnderCheck: checks[1]?.parentElement?.nextElementSibling === slot,
  };
  act(() => root.unmount());
  host.remove();
  return seen;
}

/** What checkSecond sees when the slot and the refusal sit under the second
 * Check. */
const underSecondCheck = {
  checks: 2,
  hintHidden: true,
  refusal: m.quiz_captcha_failed(),
  slotBefore: null,
  slotUnderCheck: true,
};

it('puts the slot and the refusal under the clicked Check on the shared quiz page', async () => {
  anonymous.gradeAnonymousQuiz.mockRejectedValue(refusal());
  const seen = await checkSecond(
    <SharedQuiz
      quiz={
        {
          author: { name: 'Mia' },
          id: 'qz_1',
          name: 'Cells',
          questions,
          updatedAt: '2026-10-25T00:00:00Z',
        } as AnonymousQuiz
      }
      token="qz_1.sig"
    />
  );
  expect(seen).toEqual(underSecondCheck);
  expect(anonymous.gradeAnonymousQuiz).toHaveBeenCalledWith('qz_1.sig', {
    answers: {},
    localId: 'local-1',
    questionId: 'q2',
    turnstileToken: 'turnstile-token',
  });
});

it('puts the slot and the refusal under the clicked Check in a shared note', async () => {
  anonymous.gradeAnonymousNoteQuiz.mockRejectedValue(refusal());
  const seen = await checkSecond(
    <PublicQuizEmbed
      embed={{ id: 'qz_2', kind: 'quiz', questions } as AnonymousEmbed}
      token="note.sig"
    />
  );
  expect(seen).toEqual(underSecondCheck);
  expect(anonymous.gradeAnonymousNoteQuiz).toHaveBeenCalledWith(
    'note.sig',
    'qz_2',
    {
      answers: {},
      localId: 'local-1',
      questionId: 'q2',
      turnstileToken: 'turnstile-token',
    }
  );
});
