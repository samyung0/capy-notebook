import { describe, expect, it } from 'vitest';
import { resolveOfficeRuntimeConfig } from './officeRuntimeConfig';

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
    // Clipboard access for the editors' menus; the sandbox stays as it was.
    expect(config.allow).toBe('clipboard-read; clipboard-write');
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
