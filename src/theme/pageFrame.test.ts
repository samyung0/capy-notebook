import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_FRAME,
  dotColor,
  FRAME_PRESETS,
  frameColors,
  mixColor,
  pageFrameStyle,
  STRENGTH_MAX,
  sanitizePageFrame,
  shuffleFrame,
} from './pageFrame';

describe('sanitizePageFrame', () => {
  it('keeps a valid frame', () => {
    const frame = {
      colours: 'custom',
      dots: [{ x: 0.2, y: 0.4 }],
      frosted: ['left', 'right'],
      pattern: 'mesh',
      strength: 0.5,
    };
    expect(sanitizePageFrame(frame)).toEqual(frame);
    expect(sanitizePageFrame({ ...frame, frosted: [] }).frosted).toEqual([]);
  });

  it('replaces each bad field with the default and caps strength', () => {
    expect(
      sanitizePageFrame({
        colours: 'neon',
        dots: [{ x: 2, y: 0 }, 'red'],
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

describe('frameColors', () => {
  it('draws a preset as approved at its own strength', () => {
    const { stops, strength } = FRAME_PRESETS.sea;
    expect(
      frameColors({ ...DEFAULT_PAGE_FRAME, colours: 'sea', strength })
    ).toEqual(stops.map((s) => mixColor(s, '#ffffff', 0.25 * 0.75)));
  });

  it('gives three colours for one to three custom colours', () => {
    for (const n of [1, 2, 3]) {
      const dots = DEFAULT_PAGE_FRAME.dots.slice(0, n);
      expect(
        frameColors({ ...DEFAULT_PAGE_FRAME, colours: 'custom', dots })
      ).toHaveLength(3);
    }
  });

  it('reads hue across the field', () => {
    expect(dotColor({ x: 0, y: 0 })).toBe('#f63131');
    expect(dotColor({ x: 1 / 3, y: 0 })).toBe('#31f631');
  });
});

describe('shuffleFrame', () => {
  it('keeps the pattern and number of colours as custom colours', () => {
    const frame = { ...DEFAULT_PAGE_FRAME, pattern: 'glow' as const };
    const shuffled = shuffleFrame(frame);
    expect(shuffled).toMatchObject({ colours: 'custom', pattern: 'glow' });
    expect(shuffled.dots).toHaveLength(frame.dots.length);
    expect(shuffled.strength).toBeLessThanOrEqual(STRENGTH_MAX);
  });
});

describe('pageFrameStyle', () => {
  it('draws nothing for None', () => {
    expect(
      pageFrameStyle({ ...DEFAULT_PAGE_FRAME, pattern: 'none' })
    ).toBeNull();
  });

  it('draws the pattern from the registered colour properties', () => {
    const style = pageFrameStyle({ ...DEFAULT_PAGE_FRAME, pattern: 'arc' });
    expect(style?.['--page-frame-a']).toBe(frameColors(DEFAULT_PAGE_FRAME)[0]);
    expect(style?.['--page-frame-image']).toContain('var(--page-frame-c)');
  });
});
