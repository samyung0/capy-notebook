import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { AccountBar } from './main';

// main.tsx mounts into #summary-auth on import. The stub runs before the
// imports, so the module graph loads outside the test's timeout.
vi.hoisted(() => vi.stubGlobal('document', { getElementById: () => null }));
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
});
