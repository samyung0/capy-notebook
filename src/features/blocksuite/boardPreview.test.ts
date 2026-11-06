import { expect, it } from 'vitest';
import { toBase64 } from './base64';
import { SAVED, withElements } from './boardFixture';
import { BoardLoadError } from './boardLoad';
import { drawBoardPreview } from './boardPreview';

const SIZE = { height: 120, width: 180 };
const SVG_HEAD = /^<svg [^>]*width="180" height="120"/;
const RED_STROKE = /<path d="([^"]*)" stroke="#e03131"/;

it('draws the plane card, its marks and its axes', () => {
  const svg = drawBoardPreview(SAVED, SIZE);
  expect(svg).toMatch(SVG_HEAD);
  expect(svg).toContain('stroke="#6f6f6c"');
});

it('keeps a long stroke to what the preview can show', () => {
  const points = Array.from({ length: 2000 }, (_, i) => [i / 4, (i % 50) / 4]);
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        color: '#e03131',
        lineWidth: 4,
        points,
        type: 'brush',
        xywh: '[0,600,500,20]',
      })
    ),
    SIZE
  );
  const stroke = svg.match(RED_STROKE)?.[1] ?? '';
  expect(stroke.split('L').length).toBeLessThan(400);
});

it('draws a connector saved before the board placed it, between its ends', () => {
  const svg = drawBoardPreview(
    toBase64(
      withElements(
        {
          id: 'box',
          shapeType: 'rect',
          strokeColor: '#000000',
          type: 'shape',
          xywh: '[900,0,100,50]',
        },
        {
          source: { id: 'box', position: [0.5, 1] },
          stroke: '#1971c2',
          target: { position: [950, 300] },
          type: 'connector',
        }
      )
    ),
    SIZE
  );
  expect(svg).toContain('stroke="#1971c2"');
});

it('refuses a board that does not check out', () => {
  expect(() => drawBoardPreview('AAAA', SIZE)).toThrow(BoardLoadError);
});
