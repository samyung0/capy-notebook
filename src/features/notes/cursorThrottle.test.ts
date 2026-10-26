import { afterEach, expect, it, vi } from 'vitest';
import { throttleCursorPosition } from './cursorThrottle';

afterEach(() => vi.useRealTimers());

/** An editor whose cursor moves to `range`, as withCursors sends it. */
function cursorEditor(connected = () => true) {
  const sent: unknown[] = [];
  const editor = {
    selection: null as unknown,
    sendCursorPosition: (range: unknown) => sent.push(range),
  };
  const restore = throttleCursorPosition(
    editor,
    50,
    () => Date.now(),
    connected
  );
  const move = (range: unknown) => {
    editor.selection = range;
    editor.sendCursorPosition(range);
  };
  return { editor, move, restore, sent };
}

it('sends at most one cursor per 50 ms and always the latest one', () => {
  vi.useFakeTimers();
  const { move, restore, sent } = cursorEditor();
  move('a');
  move('b');
  move('c');
  expect(sent).toEqual(['a']);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual(['a', 'c']);
  vi.advanceTimersByTime(100);
  move('d');
  expect(sent).toEqual(['a', 'c', 'd']);
  restore();
  move('e');
  expect(sent).toEqual(['a', 'c', 'd', 'e']);
});

// Q229 (found in CAPY-WEB-7): a send that waited sent the range it was given
// up to 50 ms earlier; a remote change in between moved the selection, and
// withCursors threw "Path doesn't match yText" from the timer.
it('a send that waited sends the selection as it is then', () => {
  vi.useFakeTimers();
  const { editor, move, sent } = cursorEditor();
  move('a');
  move('b');
  // A remote change moves the selection before the wait ends.
  editor.selection = 'b moved';
  vi.advanceTimersByTime(50);
  expect(sent).toEqual(['a', 'b moved']);
});

it('a send that waited is dropped once the editor is unbound', () => {
  vi.useFakeTimers();
  let bound = true;
  const { move, sent } = cursorEditor(() => bound);
  move('a');
  move('b');
  bound = false;
  vi.advanceTimersByTime(50);
  expect(sent).toEqual(['a']);
});
