import { describe, expect, it } from 'vitest';
import { pptxDeckFaces } from './pptxFonts';

const faces = (parts: string[]) =>
  pptxDeckFaces(parts).map(
    ({ bold, family, italic }) =>
      `${family}${bold ? ' bold' : ''}${italic ? ' italic' : ''}`
  );

describe('the faces a deck viewer loads', () => {
  it('always has Arial regular first (the fallback) and bold (tables and chart titles)', () => {
    expect(
      faces(['<a:rPr lang="en-US"><a:latin typeface="Calibri"/></a:rPr>'])
    ).toEqual(['Arial', 'Arial bold']);
  });

  it('adds italics only when a part sets italic, as the parser reads it', () => {
    for (const value of ['1', 'true', 'on'])
      expect(faces([`<a:rPr i="${value}"/>`])).toEqual([
        'Arial',
        'Arial bold',
        'Arial italic',
        'Arial bold italic',
      ]);
    expect(faces(['<a:rPr i="0" b="1"/>'])).toEqual(['Arial', 'Arial bold']);
  });

  it('adds Cambria only when a part names it, a theme font included', () => {
    expect(
      faces(['<a:majorFont><a:latin typeface="Cambria"/></a:majorFont>'])
    ).toEqual(['Arial', 'Arial bold', 'Cambria', 'Cambria bold']);
    expect(faces(['<a:latin typeface="Cambria Math"/>'])).toEqual([
      'Arial',
      'Arial bold',
    ]);
  });
});
