import type { ReactNode } from 'react';
import { prerender } from 'react-dom/static';
import { expect, it, vi } from 'vitest';

/* A shared note that embeds a quiz loads the session, so a signed-in
   visitor's embedded quiz check takes the signed-in route (Q311, Q350). The
   real session module is used; only Clerk's side (ShareAuth) is faked. */

const { anonymous, rendered } = vi.hoisted(() => ({
  anonymous: {
    anonymousNoteAssetUrl: vi.fn(),
    checkSharedNoteQuiz: vi.fn(),
    gradeAnonymousNoteQuiz: vi.fn(),
  },
  rendered: [] as ReactNode[],
}));
vi.mock('@/api/anonymous', () => anonymous);
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: (node: ReactNode) => rendered.push(node) }),
  hydrateRoot: vi.fn(),
}));
vi.mock('@/components/app/AppToaster', () => ({ AppToaster: () => null }));
// Clerk answers that the visitor is signed in.
vi.mock('./ShareAuth', async () => {
  const { settleSession } = await import('./session');
  return {
    default: () => {
      settleSession(true);
      return null;
    },
  };
});
vi.mock('./turnstile', () => ({ takeTurnstileToken: async () => 'token' }));
vi.mock('@/lib/localDb', () => ({ anonymousId: async () => 'local-1' }));

vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_share');
const { hydrateIslands } = await import('./islands');
const { gradeEmbeddedQuiz } = await import('./PublicQuizEmbed');

it('loads the session on a note embedding a quiz, so a signed-in check skips the captcha', async () => {
  vi.stubGlobal('document', {
    body: { appendChild: (node: object) => node },
    createElement: () => ({}),
  });
  await hydrateIslands(
    {
      embeds: [{ id: 'qz_1', kind: 'quiz' }],
      kind: 'notes',
      token: 'note.tok',
    },
    []
  );
  for (const node of rendered) await prerender(node);
  await gradeEmbeddedQuiz('note.tok', 'qz_1', { a: 'b' });
  expect(anonymous.checkSharedNoteQuiz).toHaveBeenCalledWith(
    'note.tok',
    'qz_1',
    { a: 'b' }
  );
  expect(anonymous.gradeAnonymousNoteQuiz).not.toHaveBeenCalled();
});
