import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openPresenterWindow,
  presenterTokenFromUrl,
  presenterWindowUrl,
  resolveOfficeRuntimeConfig,
} from './officeRuntimeConfig';

const SEPARATE_ORIGIN_PATTERN = /separate origin/;

describe('Office runtime origin', () => {
  it('uses a precise cross-origin postMessage target', () => {
    const config = resolveOfficeRuntimeConfig({
      appOrigin: 'https://app.example.com',
      configuredOrigin: 'https://office.example.com/path',
      production: true,
    });

    expect(config.error).toBeNull();
    expect(config.origin).toBe('https://office.example.com');
    // Clipboard for the editors' menus, full screen for PPTX Present; the
    // sandbox stays as it was.
    expect(config.allow).toBe('clipboard-read; clipboard-write; fullscreen');
    expect(config.sandbox).toBe('allow-same-origin allow-scripts');
    expect(config.url).toBe(
      'https://office.example.com/office-runtime.html?parentOrigin=https%3A%2F%2Fapp.example.com'
    );
  });

  it('rejects the app origin in production', () => {
    const config = resolveOfficeRuntimeConfig({
      appOrigin: 'https://app.example.com',
      configuredOrigin: '',
      production: true,
    });

    expect(config.error).toMatch(SEPARATE_ORIGIN_PATTERN);
  });
});

describe('PPTX presenter window', () => {
  it("is the runtime's own page on its origin, carrying the token it hands over", () => {
    const url = presenterWindowUrl('https://office.example.com', 'a1-b2');
    expect(url).toBe(
      'https://office.example.com/office-runtime.html#presenter=a1-b2'
    );
    expect(presenterTokenFromUrl(new URL(url).hash)).toBe('a1-b2');
    expect(presenterTokenFromUrl('')).toBeNull();
    expect(presenterTokenFromUrl('#presenter=')).toBeNull();
    expect(presenterTokenFromUrl('#presenter=a b')).toBeNull();
  });

  it('opens a new window every time, Google Slides-sized; null when blocked', () => {
    const open = vi.fn<
      (url: string, target: string, features: string) => Window | null
    >(() => null);
    vi.stubGlobal('window', { open });
    expect(openPresenterWindow('https://office.example.com', 't1')).toBeNull();
    expect(open).toHaveBeenCalledWith(
      'https://office.example.com/office-runtime.html#presenter=t1',
      '_blank',
      'popup,width=860,height=640'
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
