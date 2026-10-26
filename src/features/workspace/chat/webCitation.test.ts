import { describe, expect, it } from 'vitest';
import { webHref } from './webCitation';

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
});
