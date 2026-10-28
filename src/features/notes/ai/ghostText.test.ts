import { describe, expect, it } from 'vitest';
import { contextBefore, endsAtTrigger, GHOST_CONTEXT_BYTES } from './ghostText';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('contextBefore', () => {
  it('keeps whole blocks back from the caret within the byte window', () => {
    const caret = 'Glycolysis splits glucose into ';
    const heading = '## Glycolysis';
    const old = 'x'.repeat(GHOST_CONTEXT_BYTES);
    expect(contextBefore([caret, heading, old])).toBe(`${heading}\n\n${caret}`);
  });

  it('keeps the end of a caret block longer than the window', () => {
    const before = contextBefore([`開頭${'字'.repeat(600)}`]);
    expect(bytes(before)).toBeLessThanOrEqual(GHOST_CONTEXT_BYTES);
    expect(before.endsWith('字')).toBe(true);
  });
});

describe('endsAtTrigger', () => {
  it('fires after a space or a CJK character or punctuation mark', () => {
    expect(endsAtTrigger('split into ')).toBe(true);
    expect(endsAtTrigger('清廷從湖北調兵')).toBe(true);
    expect(endsAtTrigger('入川鎮壓，')).toBe(true);
  });
});
