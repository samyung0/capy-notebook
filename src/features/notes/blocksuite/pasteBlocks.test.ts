import { describe, expect, it } from 'vitest';
import { ANSWER_CLIPBOARD_TYPE } from '@/features/workspace/chat/answerClipboard';
import { answerSnapshots, markdownSnapshots } from './pasteBlocks';

const text = (delta: unknown) => ({
  '$blocksuite:internal:text$': true,
  delta,
});

describe('paste blocks', () => {
  it('reads pasted Markdown into block snapshots', () => {
    const [heading, item] = markdownSnapshots('# Cells\n\n- membrane');
    expect(heading).toMatchObject({
      flavour: 'affine:paragraph',
      props: { text: text([{ insert: 'Cells' }]), type: 'h1' },
      type: 'block',
    });
    expect(item).toMatchObject({
      flavour: 'affine:list',
      props: { text: text([{ insert: 'membrane' }]), type: 'bulleted' },
    });
  });

  it(`reads a ${ANSWER_CLIPBOARD_TYPE} copy, callouts with their variant`, () => {
    const [prose, callout] = answerSnapshots(
      JSON.stringify([
        { md: 'Cells **divide**.' },
        { callout: 'tip', md: 'Remember the jobs' },
      ])
    );
    expect(prose.props.text).toEqual(
      text([
        { insert: 'Cells ' },
        { attributes: { bold: true }, insert: 'divide' },
        { insert: '.' },
      ])
    );
    expect(callout).toMatchObject({
      children: [
        {
          flavour: 'affine:paragraph',
          props: { text: text([{ insert: 'Remember the jobs' }]) },
        },
      ],
      flavour: 'affine:callout',
      props: { variant: 'tip' },
    });
  });
});
