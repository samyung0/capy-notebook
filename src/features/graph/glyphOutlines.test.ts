import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { validGraphSvg } from '@/features/questions/validation';
import { type Drawn, replay, shapes } from './formula';
import { glyphOutlines } from './glyphOutlines';
import { type Measure, SvgRecorder } from './svg';

const measure: Measure = (font, text) =>
  text.length * Number.parseFloat(font) * 0.5;

/** KaTeX's own TTFs, read from the package as the export fetches them. */
const fromPackage = async (url: string) => {
  const name = url.split('?')[0].split('/').at(-1) as string;
  const bytes = await readFile(
    new URL(`../../../node_modules/katex/dist/fonts/${name}`, import.meta.url)
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
};

it('writes a formula as glyph outlines, rules and KaTeX paths, no text', async () => {
  // A stretched sign's picture, which the recorder never reads: its paths are
  // what `shapes` keeps for it.
  const root = {} as HTMLImageElement;
  shapes.set(root, {
    aspect: 'xMinYMin slice',
    color: 'rgb(0, 0, 0)',
    paths: ['M95 702c-2.7 0-7.17-2.7-13.5-8z'],
    viewBox: [0, 0, 400_000, 1080],
  });
  // √x̄²: a glyph in each of two faces, a bar and a stretched root sign.
  const drawn: Drawn = {
    h: 40,
    steps: [
      {
        color: 'rgb(0, 0, 0)',
        font: 'italic 400 24px KaTeX_Math, "Times New Roman", serif',
        kind: 'text',
        text: 'x',
        x: 20,
        y: 30,
      },
      {
        color: 'rgb(0, 0, 0)',
        font: 'normal 400 16.8px KaTeX_Main, "Times New Roman", serif',
        kind: 'text',
        text: '2',
        x: 34,
        y: 20,
      },
      { color: 'rgb(0, 0, 0)', h: 1, kind: 'rule', w: 14, x: 20, y: 10 },
      {
        clip: { h: 30, w: 40, x: 4, y: 6 },
        h: 30,
        image: root,
        kind: 'shape',
        w: 9600,
        x: 4,
        y: 6,
      },
    ],
    w: 48,
  };
  const outlines = await glyphOutlines(
    [
      { bold: false, family: 'KaTeX_Math', italic: true },
      { bold: false, family: 'KaTeX_Main', italic: false },
    ],
    fromPackage
  );
  const recorder = new SvgRecorder(120, 60, measure, '', outlines);
  recorder.translate(10, 5);
  recorder.scale(0.75, 0.75);
  replay(recorder, drawn);
  const svg = recorder.toString();
  expect(validGraphSvg(svg)).toBe(true);
  expect(svg).not.toContain('<text');
  // Two glyph outlines, the bar and the root's own path, fitted to its box.
  expect(svg.match(/<path d="M[^"]+Z" fill="rgb\(0, 0, 0\)"\/>/g)).toHaveLength(
    2
  );
  expect(svg).toContain('<rect');
  expect(svg).toContain('transform="matrix(');
});
