import { expect, it, vi } from 'vitest';
import { takeKeyboard } from './takeKeyboard';

// The frame's window as an event target with its document's focus (the tests
// run without a DOM).
function frame(hasFocus: boolean) {
  const body = {};
  const document = {
    activeElement: body as unknown,
    body,
    hasFocus: () => hasFocus,
  };
  const target = Object.assign(new EventTarget(), { document });
  return { document, target, window: target as unknown as Window };
}

// Q690: the grid takes the keyboard once its workbook is ready.
it('takes the keyboard at once in a frame that has the focus', () => {
  const focus = vi.fn();
  takeKeyboard(focus, frame(true).window);
  expect(focus).toHaveBeenCalledTimes(1);
});

it('waits for the frame to get the focus, then takes it', () => {
  const focus = vi.fn();
  const { target, window } = frame(false);
  takeKeyboard(focus, window);
  expect(focus).not.toHaveBeenCalled();
  target.dispatchEvent(new Event('focus'));
  expect(focus).toHaveBeenCalledTimes(1);
});

it('leaves a field in the frame that already has the focus', () => {
  const focus = vi.fn();
  const { document, target, window } = frame(false);
  takeKeyboard(focus, window);
  document.activeElement = { tagName: 'INPUT' };
  target.dispatchEvent(new Event('focus'));
  expect(focus).not.toHaveBeenCalled();
});
