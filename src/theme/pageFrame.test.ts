import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_FRAME,
  dotColor,
  FRAME_PRESETS,
  frameStops,
  pageFrameStyle,
  STRENGTH_MAX,
  sanitizePageFrame,
} from './pageFrame';

const TEXTURE_OVER_GRADIENT = /^url\(".+"\), linear-gradient\(180deg/;

describe('sanitizePageFrame', () => {
  it('keeps a valid frame', () => {
    const frame = {
      colours: 'custom',
      dots: [{ x: 0.2, y: 0.4 }],
      grain: 0.1,
      pattern: 'waves',
      strength: 0.5,
    };
    expect(sanitizePageFrame(frame)).toEqual(frame);
  });

  it('replaces each bad field with the default and caps strength', () => {
    expect(
      sanitizePageFrame({
        colours: 'neon',
        dots: [{ x: 2, y: 0 }, 'red'],
        grain: -1,
        pattern: 'stripes',
        strength: 1,
      })
    ).toEqual({ ...DEFAULT_PAGE_FRAME, strength: STRENGTH_MAX });
    expect(sanitizePageFrame('garbage')).toEqual(DEFAULT_PAGE_FRAME);
  });

  it('keeps at most three colours', () => {
    const dots = [0.1, 0.2, 0.3, 0.4].map((x) => ({ x, y: 0.5 }));
    expect(sanitizePageFrame({ dots }).dots).toHaveLength(3);
  });
});

describe('frameStops', () => {
  it('uses the preset, or three stops from one to three custom colours', () => {
    expect(frameStops({ ...DEFAULT_PAGE_FRAME, colours: 'sea' })).toEqual(
      FRAME_PRESETS.sea
    );
    for (const n of [1, 2, 3]) {
      const dots = DEFAULT_PAGE_FRAME.dots.slice(0, n);
      expect(
        frameStops({ ...DEFAULT_PAGE_FRAME, colours: 'custom', dots })
      ).toHaveLength(3);
    }
  });

  it('reads hue across the field', () => {
    expect(dotColor({ x: 0, y: 0 })).toBe('#f63131');
    expect(dotColor({ x: 1 / 3, y: 0 })).toBe('#31f631');
  });
});

describe('pageFrameStyle', () => {
  it('draws nothing for None', () => {
    expect(pageFrameStyle(DEFAULT_PAGE_FRAME)).toBeNull();
  });

  it('gives a textured pattern its texture over the gradient', () => {
    const style = pageFrameStyle({ ...DEFAULT_PAGE_FRAME, pattern: 'painted' });
    expect(style?.['--page-frame-image']).toMatch(TEXTURE_OVER_GRADIENT);
    expect(style?.['--page-frame-blend']).toBe('overlay, normal');
    expect(style?.['--page-frame-grain']).toBe(
      String(DEFAULT_PAGE_FRAME.grain)
    );
  });
});
