import { expect, it, vi } from 'vitest';
import { registerTourPanels, startTour, stopTour } from './tourStore';

it('puts the workspace panel back when the tour stops', () => {
  const restore = vi.fn();
  const unregister = registerTourPanels({
    current: { restore, showChats: vi.fn(), showFiles: vi.fn() },
  });

  startTour('ws_1');
  stopTour();

  expect(restore).toHaveBeenCalledOnce();
  unregister();
});
