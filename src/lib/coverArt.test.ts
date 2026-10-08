import { expect, it } from 'vitest';
import type { CoverConfig } from '@/api/types';
import { coverPaint } from './coverArt';

const SVG_URL = /^url\(["']data:image\/svg\+xml[,;]/;
// A raw & or < in text breaks the whole image, as the latin glyph set's & once did.
const RAW_AMPERSAND = /&(?!#\d+;|[a-z]+;)/;

it('draws every cover style and escapes text inside the SVG', () => {
  const color = '#7866cf';
  const covers: CoverConfig[] = [
    { color, kind: 'latin', style: 'symbols' },
    { color, kind: 'kana', style: 'doodles' },
    { color, style: 'shelf' },
    { color: '#fbf9f3', kind: 'math', line: 'Q&A <1>', style: 'paper' },
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
