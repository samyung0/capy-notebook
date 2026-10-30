import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { citedBlocks } from './noteCitation';

const { document } = parseHTML('<!doctype html><html><body></body></html>');

function note(...blocks: string[]) {
  const root = document.createElement('div');
  root.innerHTML = blocks.join('');
  return root;
}

const ids = (blocks: HTMLElement[]) => blocks.map((block) => block.id);

describe('citedBlocks', () => {
  it('finds a passage through its Markdown marks', () => {
    const root = note(
      '<h2 id="a">Cell membrane</h2>',
      '<p id="b">The bilayer is <strong>selectively</strong> permeable.</p>',
      '<p id="c">Another paragraph entirely.</p>'
    );
    expect(
      ids(citedBlocks(root, 'The bilayer is **selectively** permeable.'))
    ).toEqual(['b']);
  });

  it('covers every block of a chunk', () => {
    const root = note(
      '<p id="a">An opening paragraph stays out.</p>',
      '<h2 id="b">Osmosis explained</h2>',
      '<p id="c">Water moves across the membrane.</p>',
      '<p id="d">A closing paragraph stays out.</p>'
    );
    const quote = '## Osmosis explained\n\nWater moves across the membrane.';
    expect(ids(citedBlocks(root, quote))).toEqual(['b', 'c']);
  });

  it('reads a table row and a snippet cut mid-sentence', () => {
    const root = note(
      '<table id="a"><tr><td>Simple diffusion</td><td>No ATP</td></tr></table>',
      '<p id="b">Active transport needs energy from the cell at every step.</p>'
    );
    expect(ids(citedBlocks(root, '| Simple diffusion | No ATP |'))).toEqual([
      'a',
    ]);
    expect(
      ids(citedBlocks(root, 'Active transport needs energy from'))
    ).toEqual(['b']);
  });

  it('places a line found twice by another line of the snippet', () => {
    const root = note(
      '<p id="a">The same repeated sentence here.</p>',
      '<p id="b">The same repeated sentence here.</p>',
      '<p id="c">A longer sentence that only sits in one block.</p>'
    );
    const quote =
      'The same repeated sentence here.\nA longer sentence that only sits in one block.';
    expect(ids(citedBlocks(root, quote))).toEqual(['b', 'c']);
  });

  it('finds nothing for edited or ambiguous text', () => {
    const root = note(
      '<p id="a">The same repeated sentence here.</p>',
      '<p id="b">The same repeated sentence here.</p>'
    );
    expect(citedBlocks(root, 'Text the note no longer holds.')).toEqual([]);
    expect(citedBlocks(root, 'The same repeated sentence here.')).toEqual([]);
  });
});
