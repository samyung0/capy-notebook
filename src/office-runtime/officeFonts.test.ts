import { expect, test } from 'vitest';
import { officeFonts } from './officeFonts';

test('DOCX layout gets the CJK faces it measures and paints with', () => {
  const provider = officeFonts.createFontProvider();
  expect(provider.resolveScriptFallback('cjk-tc', false, false)).toBeTypeOf(
    'function'
  );
  expect(provider.resolve('Microsoft JhengHei', false, false)).toBeTypeOf(
    'function'
  );
});
