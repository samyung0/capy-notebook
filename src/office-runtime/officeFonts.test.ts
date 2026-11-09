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
  paintedFaces,
  paintedFamilies,
  registerOfficeFaces,
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
