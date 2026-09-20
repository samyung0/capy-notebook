import { expect, it } from 'vitest';
import { chatInputLimit } from './chatInputLimit';

it('shows the counter at 80% and accepts exactly 5,000 Unicode code points', () => {
  for (const character of ['a', '光', '😀']) {
    expect(chatInputLimit(character.repeat(3999)).visible).toBe(false);
    expect(chatInputLimit(character.repeat(4000)).visible).toBe(true);
    expect(chatInputLimit(character.repeat(5000))).toEqual({
      count: 5000,
      exceeded: false,
      visible: true,
    });
    expect(chatInputLimit(character.repeat(5001)).exceeded).toBe(true);
  }
  expect(chatInputLimit('a 光\n😀').count).toBe(5);
});
