import { describe, expect, it } from 'vitest';
import { HTML_EMBED_MAX_COUNT } from '@/features/materials/document';
import { TABLE_VIEW_LIMITS } from '../tableView/model';
import { withinBlockCaps } from './countCaps';

const view = (id: string) => ({
  children: [{ text: '' }],
  id,
  type: 'table_view',
});
const embed = (id: string) => ({
  children: [{ text: '' }],
  html: '<p>x</p>',
  id,
  type: 'html_embed',
});
const p = { children: [{ text: 'x' }], type: 'p' };

describe('the counted block caps on paste and Duplicate', () => {
  it('keeps the table views that fit and leaves out the rest, nested ones too', () => {
    const note = Array.from({ length: TABLE_VIEW_LIMITS.count - 1 }, (_, i) =>
      view(`tv${i}`)
    );
    const pasted = [
      view('a'),
      p,
      { children: [view('b')], type: 'blockquote' },
    ];
    const { dropped, nodes } = withinBlockCaps(note, pasted);
    expect(dropped).toEqual(['table_view']);
    expect(nodes).toEqual([
      view('a'),
      p,
      {
        children: [{ children: [{ text: '' }], type: 'p' }],
        type: 'blockquote',
      },
    ]);
  });

  it('leaves out an interactive block Duplicate would add to a note at its cap', () => {
    const note = Array.from({ length: HTML_EMBED_MAX_COUNT }, (_, i) =>
      embed(`e${i}`)
    );
    expect(withinBlockCaps(note, [embed('copy'), view('a')])).toEqual({
      dropped: ['html_embed'],
      nodes: [view('a')],
    });
  });

  it('passes the nodes through when there is room', () => {
    const pasted = [view('a'), embed('b'), p];
    expect(withinBlockCaps([], pasted)).toEqual({
      dropped: [],
      nodes: pasted,
    });
  });
});
