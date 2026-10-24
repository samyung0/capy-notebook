import { describe, expect, it } from 'vitest';
import { webHref, webMeta } from './webCitation';

describe('web citations', () => {
  it('link only to http and https pages', () => {
    expect(webHref('https://example.org/a?b=1')).toBe(
      'https://example.org/a?b=1'
    );
    expect(webHref('http://example.org')).toBe('http://example.org/');
    expect(webHref('javascript:alert(1)')).toBeUndefined();
    expect(webHref('data:text/html,hi')).toBeUndefined();
    expect(webHref('not a url')).toBeUndefined();
    expect(webHref(undefined)).toBeUndefined();
  });

  it('name the site and the date when known', () => {
    const base = { fileId: '', fileName: 'Title', snippet: 's' };
    expect(
      webMeta({ ...base, published: '2025-05-12', siteName: 'example.org' })
    ).toBe('example.org, 2025-05-12');
    expect(webMeta({ ...base, siteName: 'example.org' })).toBe('example.org');
  });
});
