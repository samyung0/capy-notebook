import { expect, it } from 'vitest';
import type { ExamCover } from '@/api/types';
import { coverPaint } from './examCover';

const SVG_URL = /^url\(["']data:image\/svg\+xml[,;]/;
// A raw & or < in text breaks the whole image, as the latin glyph set's & once did.
const RAW_AMPERSAND = /&(?!#\d+;|[a-z]+;)/;

it('draws every cover style and escapes text inside the SVG', () => {
  const color = '#7866cf';
  const covers: ExamCover[] = [
    { color, kind: 'latin', style: 'symbols' },
    { color, kind: 'kana', style: 'doodles' },
    { color, style: 'shelf' },
    { color, kind: 'math', line: 'Q&A <1>', style: 'paper' },
    { color, style: 'type' },
    { color, pattern: 'hexagons', style: 'geo' },
    { color, pattern: 'graphPaper', style: 'hero' },
  ];
  for (const cover of covers) {
    const { image } = coverPaint('exam', 'A&B <x>', cover);
    expect(image).toMatch(SVG_URL);
    const svg = decodeURIComponent(image);
    expect(svg).not.toMatch(RAW_AMPERSAND);
    expect(svg).not.toContain('<x>');
  }
});
