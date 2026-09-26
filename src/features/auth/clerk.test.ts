import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirectAfterAuth, signInHref } from './clerk';

// Vitest runs these in node; the helper only reads window.location.
function withSearch(search: string) {
  vi.stubGlobal('window', {
    location: { origin: 'https://capynotebook.com', search },
  });
}

describe('redirectAfterAuth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps same-origin paths and absolute URLs', () => {
    withSearch('?redirect_url=%2Fworkspaces%2Fws_1%3Ftab%3Dfiles%23top');
    expect(redirectAfterAuth()).toBe('/workspaces/ws_1?tab=files#top');
    withSearch(
      `?redirect_url=${encodeURIComponent('https://capynotebook.com/workspace-invites/tok')}`
    );
    expect(redirectAfterAuth()).toBe('/workspace-invites/tok');
  });

  it('returns to the page AuthGate sent to sign-in', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/workspace-invites/tok', search: '?x=1' },
    });
    const { pathname, search } = new URL(
      signInHref(),
      'https://capynotebook.com'
    );
    expect(pathname).toBe('/sign-in');
    withSearch(search);
    expect(redirectAfterAuth()).toBe('/workspace-invites/tok?x=1');
  });

  it('falls back to the dashboard for other origins or nothing', () => {
    withSearch('');
    expect(redirectAfterAuth()).toBe('/');
    withSearch('?redirect_url=%2F%2Fevil.example%2Fx');
    expect(redirectAfterAuth()).toBe('/');
    withSearch('?redirect_url=%2F%5Cevil.example%2Fx');
    expect(redirectAfterAuth()).toBe('/');
    withSearch(`?redirect_url=${encodeURIComponent('https://evil.example/')}`);
    expect(redirectAfterAuth()).toBe('/');
  });
});
