import { describe, expect, it } from 'vitest';
import { withEmbedStates } from './embedStatus';

describe('withEmbedStates', () => {
  it('shows the most pressing of the note and its embeds', () => {
    expect(withEmbedStates({ saveState: 'saved' }, ['syncing'])).toEqual({
      saveState: 'syncing',
    });
    expect(
      withEmbedStates({ saveState: 'syncing', slowed: true }, [
        'saved',
        'offline',
      ])
    ).toEqual({ saveState: 'offline', slowed: true });
    expect(withEmbedStates({ saveState: 'saved' }, ['opening'])).toEqual({
      saveState: 'saved',
    });
  });

  it('leaves a note still opening to say so alone', () => {
    expect(withEmbedStates({ saveState: 'opening' }, ['error'])).toEqual({
      saveState: 'opening',
    });
  });
});
