import { describe, expect, it } from 'vitest';
import { imageRoom } from './imageBudget';

describe('imageRoom', () => {
  it('leaves the budget less what the document grew since it opened and a 4 KiB slack', () => {
    expect(imageRoom('pptx', 5096, 400)).toBe(600);
    expect(imageRoom('pptx', 5096, 1200)).toBe(0);
    expect(imageRoom('pptx', 4000, 0)).toBe(0);
  });

  it('counts a DOCX picture as its base64 data URL', () => {
    expect(imageRoom('docx', 5096, 0)).toBe(750);
    expect(imageRoom('docx', 5099, 0)).toBe(750);
  });
});
