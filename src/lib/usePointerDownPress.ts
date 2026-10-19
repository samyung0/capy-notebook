import { type MouseEvent, type PointerEvent, useRef } from 'react';

/** Runs an in-place action (open, toggle, switch tab) on pointerdown rather
 * than click, as Radix menus already do. The click that follows the press is
 * swallowed; keyboard and assistive clicks (`detail` 0) still run it. Keep
 * submit, delete and navigation on click: a touch that turns into a scroll
 * has already pressed. */
export function usePointerDownPress() {
  const pressed = useRef(false);
  return (action: () => void) => ({
    onClick: (event: MouseEvent) => {
      const handled = pressed.current && event.detail > 0;
      pressed.current = false;
      if (!handled) action();
    },
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey) return;
      pressed.current = true;
      action();
    },
  });
}
