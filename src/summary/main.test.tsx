import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme/ThemeProvider';

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

it('renders verified account controls without an app router', async () => {
  vi.stubGlobal('document', { getElementById: () => null });
  try {
    const { AccountBar } = await import('./main');
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <AccountBar />
      </ThemeProvider>
    );
    expect(html).toContain('Mia');
    expect(html).toContain('summary-profile');
    expect(html).not.toContain('redirect_url');
  } finally {
    vi.unstubAllGlobals();
  }
});
