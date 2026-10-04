import { afterEach, expect, it, vi } from 'vitest';
import { throttleCursorPosition } from './cursorThrottle';

afterEach(() => vi.useRealTimers());

it('sends at most one cursor per 50 ms and always the latest one', () => {
  vi.useFakeTimers();
  const sent: unknown[] = [];
  const editor = { sendCursorPosition: (range: unknown) => sent.push(range) };
  const restore = throttleCursorPosition(editor, 50, () => Date.now());
  editor.sendCursorPosition('a');
  editor.sendCursorPosition('b');
  editor.sendCursorPosition('c');
  expect(sent).toEqual(['a']);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual(['a', 'c']);
  vi.advanceTimersByTime(100);
  editor.sendCursorPosition('d');
  expect(sent).toEqual(['a', 'c', 'd']);
  restore();
  editor.sendCursorPosition('e');
  expect(sent).toEqual(['a', 'c', 'd', 'e']);
});
