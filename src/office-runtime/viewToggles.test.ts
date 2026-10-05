import { describe, expect, it } from 'vitest';
import { readViewToggle, writeViewToggle } from './viewToggles';

function memoryStorage() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  return () => storage;
}

describe('remembered Office view toggles', () => {
  it('start off and remember the last choice for the next open, each on its own', () => {
    const storage = memoryStorage();
    expect(readViewToggle('speakerNotes', storage)).toBe(false);
    expect(readViewToggle('docxRuler', storage)).toBe(false);
    writeViewToggle('docxRuler', true, storage);
    expect(readViewToggle('docxRuler', storage)).toBe(true);
    expect(readViewToggle('speakerNotes', storage)).toBe(false);
    writeViewToggle('speakerNotes', true, storage);
    writeViewToggle('docxRuler', false, storage);
    expect(readViewToggle('docxRuler', storage)).toBe(false);
    expect(readViewToggle('speakerNotes', storage)).toBe(true);
  });

  it('keep the speaker notes choice stored before the rulers existed', () => {
    const storage = memoryStorage();
    storage().setItem('capy.pptx.speakerNotes', 'shown');
    expect(readViewToggle('speakerNotes', storage)).toBe(true);
  });

  it('start off when storage is unavailable', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    expect(() => writeViewToggle('docxRuler', true, blocked)).not.toThrow();
    expect(readViewToggle('docxRuler', blocked)).toBe(false);
  });
});
