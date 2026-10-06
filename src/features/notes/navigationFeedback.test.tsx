import { KEYS, type NavigationFeedbackStoredTarget, type Path } from 'platejs';
import {
  createPlateEditor,
  NavigationFeedbackPlugin,
  Plate,
  PlateContent,
} from 'platejs/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { navigationFeedbackPlugin } from './navigationFeedback';

const value = [
  { children: [{ text: 'Intro' }], id: 'intro', type: KEYS.p },
  { children: [{ text: 'Body' }], id: 'body', type: KEYS.p },
];

// A flash in progress, as `flashTarget` stores it. Set as the initial option:
// a server render reads the store's initial state.
const flashing = (path: Path): NavigationFeedbackStoredTarget => ({
  cycle: 1,
  duration: 1600,
  pathRef: { affinity: 'forward', current: path, unref: () => path },
  pulse: 1,
  type: 'node',
  variant: 'navigated',
});

function render(
  plugin: typeof NavigationFeedbackPlugin,
  activeTarget: NavigationFeedbackStoredTarget | null
) {
  const editor = createPlateEditor({
    plugins: [plugin.configure({ options: { activeTarget } })],
    value: structuredClone(value),
  });
  return renderToStaticMarkup(
    <Plate editor={editor}>
      <PlateContent />
    </Plate>
  );
}

const TARGET_IS_BODY = /data-nav-target="true"[^>]*>.*Body/;

describe('navigation flash', () => {
  it('marks the same node as Plate does, and nothing without a flash', () => {
    // Plate injects into elements only, so a text target marks nothing.
    for (const path of [[0], [1], [1, 0]])
      expect(render(navigationFeedbackPlugin, flashing(path))).toBe(
        render(NavigationFeedbackPlugin, flashing(path))
      );
    const flashed = render(navigationFeedbackPlugin, flashing([1]));
    expect(flashed.split('data-nav-target="true"')).toHaveLength(2);
    expect(flashed).toMatch(TARGET_IS_BODY);
    expect(render(navigationFeedbackPlugin, null)).not.toContain('data-nav');
  });
});
