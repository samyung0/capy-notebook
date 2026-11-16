import type { DocxViewerSlicedFace } from '@betteroffice/docx/viewer';
import {
  BASE_LATIN_FAMILY,
  decodeFontFaceOutsideEngine,
  resolveBundledFamilyFace,
  resolveMetricCompatFace,
} from '@betteroffice/fonts';
import { expect, onTestFinished, test, vi } from 'vitest';
import {
  keepOfficeFontBytes,
  type OfficeFace,
  officeFonts,
  officeViewerFonts,
  onOfficeFontFailure,
  openFailure,
  paintedFaces,
  paintedFamilies,
  registerOfficeFaces,
  registerSlicedFaces,
  slicedOfficeFaces,
  usedOfficeFaces,
} from './officeFonts';

const PACKED = /\.ttf\.zst$/;

test('a packed face decodes with the engine decoder, which keeps no decoded copy', async () => {
  const decoder = vi.fn(decodeFontFaceOutsideEngine);
  const load = officeFonts
    .createFontProvider(undefined, { decoder })
    .resolve('Calibri', false, false);
  const face = resolveMetricCompatFace('Calibri', false, false);
  expect(face?.file).toMatch(PACKED);
  expect((await load?.())?.byteLength).toBe(face?.byteLength);
  await load?.();
  // retain: false, so the second load decodes again.
  expect(decoder).toHaveBeenCalledTimes(2);
});

test("the DOCX viewer worker decodes packed faces without the engine's decoder", async () => {
  // The engine hands every provider its decoder, the edit WASM's (13 MB).
  const engineDecoder = vi.fn(decodeFontFaceOutsideEngine);
  const viewerFonts: typeof officeFonts = officeViewerFonts;
  const load = viewerFonts
    .createFontProvider(undefined, { decoder: engineDecoder })
    .resolve('Calibri', true, false);
  const face = resolveMetricCompatFace('Calibri', true, false);
  expect((await load?.())?.byteLength).toBe(face?.byteLength);
  expect(engineDecoder).not.toHaveBeenCalled();
});

test("DOCX's base-Latin backstop loads in the viewer worker and goes to the frame", async () => {
  keepOfficeFontBytes();
  const load = officeViewerFonts
    .createFontProvider()
    .resolveBaseLatin(false, false);
  const face = resolveBundledFamilyFace(BASE_LATIN_FAMILY, false, false);
  expect((await load?.())?.byteLength).toBe(face?.byteLength);
  const displayList = {
    pages: [
      {
        primitives: [
          { font: `400 16px "${BASE_LATIN_FAMILY}", sans-serif`, kind: 'text' },
        ],
      },
    ],
  };
  expect(usedOfficeFaces(displayList).map((used) => used.face.file)).toEqual([
    face?.file,
  ]);
});

test('a base-Latin backstop face that fails is reported as an error', async () => {
  const errors: Error[] = [];
  onTestFinished(onOfficeFontFailure((error) => errors.push(error)));
  const decoder = vi.fn(() => Promise.reject(new Error('corrupt pack')));
  const load = officeFonts
    .createFontProvider(undefined, { decoder })
    .resolveBaseLatin(true, false);
  const failure = await load?.().catch((error: unknown) => error);
  expect(errors).toEqual([failure]);
  expect(errors[0]?.message).toBe(
    `The font ${resolveBundledFamilyFace(BASE_LATIN_FAMILY, true, false)?.file} failed to load`
  );
});

test('a face whose decode fails is reported as an error', async () => {
  const errors: Error[] = [];
  onTestFinished(onOfficeFontFailure((error) => errors.push(error)));
  const decoder = vi.fn(() => Promise.reject(new Error('corrupt pack')));
  const load = officeFonts
    .createFontProvider(undefined, { decoder })
    .resolve('Cambria', false, false);
  // The loader rejects with the error its listeners got.
  const failure = await load?.().catch((error: unknown) => error);
  expect(errors).toEqual([failure]);
  expect(errors[0]?.message).toBe(
    `The font ${resolveMetricCompatFace('Cambria', false, false)?.file} failed to load`
  );
});

test('DOCX layout gets the CJK faces it measures and paints with, as slices', () => {
  const provider = officeFonts.createFontProvider();
  const fallback = provider.resolveScriptFallback('cjk-tc', false, false);
  const named = provider.resolve('Microsoft JhengHei', false, false);
  // The layout opens each from its skeleton and loads only the outline
  // chunks its glyphs need; no decoded copy is kept once a load settles.
  for (const loader of [fallback, named]) {
    expect(loader).toBeTypeOf('function');
    expect(loader?.slices?.ref.index).toBe('NotoSansTC-Regular/slices.json');
    expect(loader?.slices?.retain).toBe(false);
  }
  // A Latin face loads whole.
  expect(provider.resolve('Calibri', false, false)?.slices).toBeUndefined();
});

test('the viewer frame gets each sliced face under the families its pages paint it with', () => {
  keepOfficeFontBytes();
  const provider = officeViewerFonts.createFontProvider();
  // The registry opens these from their slices without calling the loaders.
  provider.resolve('MS Gothic', false, false);
  provider.resolve('MS Gothic', true, false);
  provider.resolveScriptFallback('cjk-jp', false, false);
  const index = 'NotoSansJP-Regular/slices.json';
  const bytes = new ArrayBuffer(8);
  const files = new Map([['NotoSansJP-Regular/c001.zst', new ArrayBuffer(2)]]);
  const displayList = {
    pages: [
      {
        primitives: [
          {
            fallbackFont: '400 16px "MS Gothic", sans-serif',
            kind: 'glyphRun',
          },
          // A list marker names the face by its private family.
          {
            font: '400 16px "Calibri", "BetterOffice Sliced 1.0", sans-serif',
            kind: 'text',
          },
        ],
      },
    ],
  };
  const sliced = slicedOfficeFaces(
    [
      {
        bytes,
        family: 'BetterOffice Sliced 1.0',
        files,
        slices: { ref: { index } } as DocxViewerSlicedFace['slices'],
      },
    ],
    displayList
  );
  // Noto Sans JP (the script fallback) paints nothing here, so it is left
  // out. The decoded files stay in the worker: Edit opens in a frame of its
  // own, which reads the slices from the HTTP cache.
  expect(sliced).toEqual([
    {
      bytes,
      families: [
        { family: 'BetterOffice Sliced 1.0' },
        { family: 'MS Gothic', style: 'normal', weight: '400' },
      ],
    },
  ]);
});

test("a layout's sliced faces are registered for it and deleted with it", async () => {
  const fonts = new Set<unknown>();
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  vi.stubGlobal(
    'FontFace',
    class {
      readonly family: string;
      constructor(family: string) {
        this.family = family;
      }
      async load() {}
    }
  );
  vi.stubGlobal('document', {
    fonts: {
      add: (face: unknown) => fonts.add(face),
      delete: (face: unknown) => fonts.delete(face),
    },
  });
  const release = await registerSlicedFaces([
    {
      bytes: new ArrayBuffer(1),
      families: [
        { family: 'BetterOffice Sliced 1.0' },
        { family: 'MS Gothic', style: 'normal', weight: '400' },
      ],
    },
  ]);
  expect([...fonts].map((face) => (face as { family: string }).family)).toEqual(
    ['BetterOffice Sliced 1.0', 'MS Gothic']
  );
  release();
  expect(fonts.size).toBe(0);
});

test('a slice that fails the View open names its file', () => {
  // What a slice fetch throws when the network fails: the fetch's own error.
  const failure = Object.assign(new TypeError('Failed to fetch'), {
    file: 'NotoSansJP-Regular/c093.zst',
    reason: 'network',
  });
  expect(openFailure(failure).message).toBe(
    'The font slice NotoSansJP-Regular/c093.zst failed to load: Failed to fetch'
  );
  expect(openFailure(new Error('corrupt')).message).toBe('corrupt');
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
    face('Calibri', 'Carlito-Regular.ttf.zst'),
    face('Calibri', 'LiberationSans-Regular.ttf.zst'),
    face('Calibri', 'Carlito-Bold.ttf.zst', 700),
    face('Cambria', 'Caladea-Regular.ttf.zst'),
  ];
  const displayList = {
    pages: [
      { primitives: [{ font: '16px Calibri, sans-serif', kind: 'text' }] },
    ],
  };
  expect(
    paintedFaces(loaded, displayList).map(({ face }) => face.file)
  ).toEqual(['Carlito-Regular.ttf.zst', 'Carlito-Bold.ttf.zst']);
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
