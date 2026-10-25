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
const buildUserProfileUrl = vi.hoisted(() =>
  vi.fn(() => 'https://accounts.example.test/user')
);
vi.mock('@/features/auth/clerkHooks', () => ({
  useClerk: () => ({ buildUserProfileUrl }),
  useUser: () => ({ user: undefined }),
}));

// Q373, Q377: Clerk's hosted account page stays unlinked, so Settings ->
// Account has no two-step verification or password row and builds no link to
// that page, even where Clerk would build one.
it('shows no link to the Clerk account page and no two-step row', () => {
  const html = renderToStaticMarkup(<AccountTab />);
  expect(html).toContain(m.settings_account());
  expect(buildUserProfileUrl).not.toHaveBeenCalled();
  expect(html).not.toContain('accounts.example.test');
  expect(html.toLowerCase()).not.toContain('two-step');
});
