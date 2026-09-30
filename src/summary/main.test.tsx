import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { AccountBar, PublicNavigation } from './main';
import { SummaryFailure } from './SummaryFailure';

// main.tsx mounts into #summary-auth on import. The stub runs before the
// imports, so the module graph loads outside the test's timeout.
vi.hoisted(() =>
  vi.stubGlobal('document', {
    getElementById: () => null,
    querySelectorAll: () => [],
  })
);
afterAll(() => vi.unstubAllGlobals());

vi.mock('@clerk/react', () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => ({
    isSignedIn: true,
    user: { firstName: 'Mia', fullName: 'Mia Chen', imageUrl: undefined },
  }),
}));
vi.mock('@/components/app/AuthProvider', () => ({
  AppAuthProvider: () => null,
}));
vi.mock('@/lib/observability', () => ({ track: vi.fn() }));

it('renders verified account controls without an app router', () => {
  const html = renderToStaticMarkup(
    <ThemeProvider>
      <AccountBar />
    </ThemeProvider>
  );
  expect(html).toContain('Mia');
  expect(html).toContain('summary-profile');
  expect(html).not.toContain('redirect_url');
  expect(html).not.toContain('role="combobox"');
});

it('uses the shared page error with manual retry only for loading failures', () => {
  const unavailable = renderToStaticMarkup(
    <SummaryFailure locale="en" status={404} />
  );
  const failed = renderToStaticMarkup(
    <SummaryFailure locale="en" status={503} />
  );
  expect(unavailable).toContain('data-error-surface="page"');
  expect(unavailable).toContain('Page not found');
  expect(unavailable).toContain(
    'The page may have moved or the address may be incorrect.'
  );
  expect(unavailable).not.toContain('Try again');
  expect(failed).toContain('data-error-surface="page"');
  expect(failed).toContain('Unable to load workspace');
  expect(failed).toContain('Try again');
});

it('offers theme, sign-in and sign-up on the public header', () => {
  const html = renderToStaticMarkup(
    <ThemeProvider>
      <PublicNavigation />
    </ThemeProvider>
  );
  expect(html).toContain('Switch to dark theme');
  expect(html).toContain('data-size="lg"');
  expect(html).toContain('Sign in');
  expect(html).toContain('Sign up');
  expect(html).not.toContain('/explore');
});
