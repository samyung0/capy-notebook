import { describe, expect, it } from 'vitest';
import { chatTurn, LIBRARY_DEFAULT } from './chatStream';

describe('the per-turn chat body', () => {
  it('starts with the Library switch on', () => {
    expect(LIBRARY_DEFAULT).toBe(true);
    expect(chatTurn(LIBRARY_DEFAULT, null)).toEqual({
      library: true,
      openResource: undefined,
    });
  });

  it('sends the switch as set for this turn and only the open item id and kind', () => {
    const open = { id: 'f_1', kind: 'file' as const, title: 'Browser title' };
    expect(chatTurn(false, open)).toEqual({
      library: false,
      openResource: { id: 'f_1', kind: 'file' },
    });
  });
});
