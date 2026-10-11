import { describe, expect, it } from 'vitest';
import { isMaterialDocument } from '@/features/materials/document';
import { convertAgentMarkdown } from '../markdownConvert';
import { customBlockCode } from './shared';

const plot = {
  lines: [{ axis: 'y', label: 'threshold −55 mV', value: -55 }],
  marks: [{ label: 'Na⁺ floods in', x: 1.2, y: -10 }],
  series: [
    {
      name: 'Membrane potential',
      points: [
        [0, -70],
        [1, -55],
        [1.5, 30],
        [3, -80],
        [5, -70],
      ],
    },
  ],
  title: 'Action potential',
  type: 'plot',
  xTitle: 'Time (ms)',
  yTitle: 'Membrane potential (mV)',
};
const fence = (body: string) => `\`\`\`plot\n${body}\n\`\`\``;

describe('plot fences in notes', () => {
  it('convert to a valid plot node and write the same block back', () => {
    const { document } = convertAgentMarkdown(
      `Before.\n\n${fence(JSON.stringify(plot))}`
    );
    const node = document.value[1];
    expect(node).toMatchObject({ block: plot, type: 'plot' });
    expect(isMaterialDocument(document)).toBe(true);
    expect(JSON.parse(customBlockCode(node as never))).toEqual(plot);
  });

  it('refuse a plot the shared block schema rejects', () => {
    const bad = { ...plot, series: [{ name: 'One', points: [[0, 1]] }] };
    expect(() => convertAgentMarkdown(fence(JSON.stringify(bad)))).toThrow();
  });
});
