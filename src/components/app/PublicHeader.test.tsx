import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme/ThemeProvider';

const clerk = vi.hoisted(() => ({
  user: { isLoaded: false, isSignedIn: false } as {
    isLoaded: boolean;
    isSignedIn: boolean;
    user?: { firstName: string; fullName: string; imageUrl?: string };
  },
}));
vi.hoisted(() => vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_x'));
vi.mock('@/api/auth', () => ({ USE_MSW: false }));
vi.mock('@clerk/react', () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => clerk.user,
}));

const { PublicAccountNav } = await import('./PublicHeader');
const render = () =>
  renderToStaticMarkup(
    <ThemeProvider>
      <PublicAccountNav returnTo="/workspaces/ws_1" />
    </ThemeProvider>
  );

beforeEach(() => {
  clerk.user = { isLoaded: false, isSignedIn: false };
});

it('holds a skeleton while the session loads', () => {
  const html = render();
  expect(html).toContain('role="status"');
  expect(html).not.toContain('Sign in');
});

it('offers theme, sign-in and sign-up to signed-out visitors', () => {
  clerk.user = { isLoaded: true, isSignedIn: false };
  const html = render();
  expect(html).toContain('Switch to dark theme');
  expect(html).toContain('href="/sign-in?redirect_url=%2Fworkspaces%2Fws_1"');
  expect(html).toContain('href="/sign-up?redirect_url=%2Fworkspaces%2Fws_1"');
});

it('shows the profile pill without an app router when signed in', () => {
  clerk.user = {
    isLoaded: true,
    isSignedIn: true,
    user: { firstName: 'Mia', fullName: 'Mia Chen' },
  };
  const html = render();
  expect(html).toContain('Mia Chen');
  expect(html).not.toContain('Sign in');
});
