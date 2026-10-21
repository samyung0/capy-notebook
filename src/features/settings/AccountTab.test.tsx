import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { AccountTab } from './AccountTab';

vi.mock('@/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/auth')>()),
  USE_MSW: true,
}));
vi.mock('@/api/hooks', () => ({
  useMe: () => ({ data: undefined }),
  useUpdateMe: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/features/auth/clerkHooks', () => ({
  useClerk: () => ({
    buildUserProfileUrl: () => 'https://accounts.example.test/user',
  }),
  useUser: () => ({ user: undefined }),
}));

// Two-step verification is turned on and off on Clerk's hosted account page
// (Epo 2026-10-21): Settings links to the URL Clerk's SDK builds.
it('links two-step verification to the account page Clerk builds', () => {
  const html = renderToStaticMarkup(<AccountTab />);
  expect(html).toContain(m.settings_two_step());
  expect(html).toContain('href="https://accounts.example.test/user"');
});
