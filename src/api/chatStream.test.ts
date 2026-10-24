import { describe, expect, it } from 'vitest';
import { chatTurn, WORKSPACE_ONLY_DEFAULT } from './chatStream';

describe('the per-turn chat body', () => {
  it('starts with Workspace only off', () => {
    expect(WORKSPACE_ONLY_DEFAULT).toBe(false);
    expect(chatTurn(WORKSPACE_ONLY_DEFAULT, null)).toEqual({
      openResource: undefined,
      workspaceOnly: false,
    });
  });

  it('sends the switch as set for this turn and only the open item id and kind', () => {
    const open = { id: 'f_1', kind: 'file' as const, title: 'Browser title' };
    expect(chatTurn(true, open)).toEqual({
      openResource: { id: 'f_1', kind: 'file' },
      workspaceOnly: true,
    });
  });
});
