import { describe, expect, it } from 'vitest';
import { readSpeakerNotes, writeSpeakerNotes } from './pptxSpeakerNotes';

function memoryStorage() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  return () => storage;
}

describe('PPTX speaker notes preference', () => {
  it('starts hidden and remembers the last choice for the next open', () => {
    const storage = memoryStorage();
    expect(readSpeakerNotes(storage)).toBe(false);
    writeSpeakerNotes(true, storage);
    expect(readSpeakerNotes(storage)).toBe(true);
    writeSpeakerNotes(false, storage);
    expect(readSpeakerNotes(storage)).toBe(false);
  });

  it('falls back to hidden when storage is unavailable', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    expect(() => writeSpeakerNotes(true, blocked)).not.toThrow();
    expect(readSpeakerNotes(blocked)).toBe(false);
  });
});
