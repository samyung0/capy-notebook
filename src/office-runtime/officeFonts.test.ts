import { expect, onTestFinished, test, vi } from 'vitest';
import {
  type OfficeFace,
  officeFonts,
  paintedFaces,
  paintedFamilies,
  registerOfficeFaces,
} from './officeFonts';

test('DOCX layout gets the CJK faces it measures and paints with', () => {
  const provider = officeFonts.createFontProvider();
  expect(provider.resolveScriptFallback('cjk-tc', false, false)).toBeTypeOf(
    'function'
  );
  expect(provider.resolve('Microsoft JhengHei', false, false)).toBeTypeOf(
    'function'
  );
});

test('the viewer frame registers only faces of the families its runs paint with', () => {
  const displayList = {
    pages: [
      {
        footer: {
          primitives: [{ font: '400 12px Cambria, sans-serif', kind: 'text' }],
        },
        primitives: [
          { font: 'italic 700 14.6667px "Calibri", sans-serif', kind: 'text' },
          {
            fallbackFont: '400 16px Microsoft JhengHei, sans-serif',
            glyphs: [{ cluster: 0, id: 1, x: 0, y: 0 }],
            kind: 'glyphRun',
          },
          { kind: 'rect' },
        ],
      },
    ],
  };
  expect(paintedFamilies(displayList)).toEqual(
    new Set(['cambria', 'calibri', 'microsoft jhenghei', 'sans-serif'])
  );
});

test('the frame gets one face per painted family, weight and style: the first loaded', () => {
  const face = (family: string, file: string, weight = 400): OfficeFace => ({
    bytes: new ArrayBuffer(1),
    face: { family, file, style: 'normal', weight } as OfficeFace['face'],
    family,
  });
  const loaded = [
    face('PMingLiU', 'NotoSansTC-Regular.otf'),
    face('PMingLiU', 'LiberationSerif-Regular.ttf'),
    face('PMingLiU', 'NotoSansTC-Bold.otf', 700),
    face('Noto Sans JP', 'NotoSansJP-Regular.otf'),
  ];
  const displayList = {
    pages: [
      { primitives: [{ font: '16px PMingLiU, sans-serif', kind: 'text' }] },
    ],
  };
  expect(
    paintedFaces(loaded, displayList).map(({ face }) => face.file)
  ).toEqual(['NotoSansTC-Regular.otf', 'NotoSansTC-Bold.otf']);
});

test('a face the frame registered once is not added again', async () => {
  const added: unknown[] = [];
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  vi.stubGlobal(
    'FontFace',
    class {
      async load() {}
    }
  );
  vi.stubGlobal('document', {
    fonts: { add: (face: unknown) => added.push(face) },
  });
  const face = (file: string): OfficeFace => ({
    bytes: new ArrayBuffer(1),
    face: { file, style: 'normal', weight: 400 } as OfficeFace['face'],
    family: 'Registered Once',
  });
  // The viewer's effect running again in the same frame (CJK faces are 4-20 MB).
  await registerOfficeFaces([face('a.ttf')]);
  await registerOfficeFaces([face('a.ttf'), face('b.ttf')]);
  expect(added).toHaveLength(1);
});
