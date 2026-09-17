import { describe, expect, it } from 'vitest';
import { curateToggleDisabled, curateToggleVisible } from './curateToggle';

const idle = { hydrating: false, messageCount: 0, streaming: false };

describe('curateToggleDisabled', () => {
  it('opens on an empty chat and locks once the thread has a history', () => {
    expect(curateToggleDisabled(idle)).toBe(false);
    expect(curateToggleDisabled({ ...idle, messageCount: 1 })).toBe(true);
    expect(curateToggleDisabled({ ...idle, streaming: true })).toBe(true);
  });

  it('stays locked until the selected thread has hydrated', () => {
    expect(curateToggleDisabled({ ...idle, hydrating: true })).toBe(true);
  });
});

describe('curateToggleVisible', () => {
  it('hides the switch from a visitor who cannot write to the workspace', () => {
    expect(curateToggleVisible({ readOnly: true })).toBe(false);
    expect(curateToggleVisible({ readOnly: false })).toBe(true);
    expect(curateToggleVisible({})).toBe(true);
  });
});
