import { describe, expect, it } from 'vitest';
import { withinTableViewCap } from './count';
import { TABLE_VIEW_LIMITS } from './model';

const view = (id: string) => ({
  children: [{ text: '' }],
  id,
  type: 'table_view',
});
const p = { children: [{ text: 'x' }], type: 'p' };

describe('the table view cap on paste and Duplicate', () => {
  it('keeps the table views that fit and leaves out the rest, nested ones too', () => {
    const note = Array.from({ length: TABLE_VIEW_LIMITS.count - 1 }, (_, i) =>
      view(`tv${i}`)
    );
    const pasted = [
      view('a'),
      p,
      { children: [view('b')], type: 'blockquote' },
    ];
    const { dropped, nodes } = withinTableViewCap(note, pasted);
    expect(dropped).toBe(true);
    expect(nodes).toEqual([
      view('a'),
      p,
      {
        children: [{ children: [{ text: '' }], type: 'p' }],
        type: 'blockquote',
      },
    ]);
  });

  it('passes the nodes through when there is room', () => {
    const pasted = [view('a'), p];
    expect(withinTableViewCap([], pasted)).toEqual({
      dropped: false,
      nodes: pasted,
    });
  });
});
