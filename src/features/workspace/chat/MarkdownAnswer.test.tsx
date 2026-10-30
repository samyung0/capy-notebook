import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Citation } from '@/api/types';
import { loadKatex } from './blocks/math';
import { MarkdownAnswer } from './MarkdownAnswer';
import { parseMarkdownAnswer } from './markdownSegments';

const answer = [
  'Light drives it. [#4]',
  '',
  '> [!WARNING] Not glucose',
  '> Oxygen comes from water. [#2]',
  '',
  ':::tabs',
  '::tab[Light]',
  'Happens in thylakoids.',
  '::tab[Dark]',
  '```chart',
  '{"kind": "bar", "title": "Rate (%)", "labels": ["A", "B"], "series": [{"name": "s", "values": [1, 2]}], "passages": [4]}',
  '```',
  ':::',
  '',
  '<details><summary>Hint</summary>',
  'Think about $E = mc^2$.',
  '</details>',
  '',
  '```python',
  '> [!TIP] inside code stays code',
  '```',
  '',
  '```ask',
  '{"question": "Which depth?", "choices": ["Intro"]}',
  '```',
].join('\n');

describe('parseMarkdownAnswer', () => {
  it('splits callouts, tabs, reveals and figures and leaves code alone', () => {
    const segments = parseMarkdownAnswer(answer);
    expect(segments.map((segment) => segment.type)).toEqual([
      'md',
      'callout',
      'tabs',
      'reveal',
      'md',
      'figure',
    ]);
    expect(segments[1]).toMatchObject({
      kind: 'warning',
      text: 'Oxygen comes from water. [#2]',
      title: 'Not glucose',
    });
    const tabs = segments[2];
    expect(tabs.type === 'tabs' && tabs.tabs[1].segments[0]).toMatchObject({
      closed: true,
      lang: 'chart',
      type: 'figure',
    });
    expect(segments[3]).toMatchObject({
      text: 'Think about $E = mc^2$.',
      title: 'Hint',
    });
  });

  it('keeps an unclosed figure open while it streams', () => {
    expect(parseMarkdownAnswer('```chart\n{"kind":')).toEqual([
      {
        body: '{"kind":',
        closed: false,
        info: '',
        lang: 'chart',
        type: 'figure',
      },
    ]);
  });
});

describe('MarkdownAnswer', () => {
  beforeAll(loadKatex);
  const citations = [{ n: 4 }, { n: 2 }] as Citation[];

  it('numbers [#n] markers by the citation list and draws the blocks', () => {
    const html = renderToStaticMarkup(
      <MarkdownAnswer citations={citations} content={answer} />
    );
    expect(html).not.toContain('[#');
    expect(html).toContain('title="Source 1"');
    expect(html).toContain('title="Source 2"');
    expect(html).toContain('Not glucose');
    expect(html).toContain('Which depth?');
    expect(html).toContain('[!TIP] inside code stays code');
  });

  it('shows a figure the block refuses as code', () => {
    const html = renderToStaticMarkup(
      <MarkdownAnswer content={'```plot\n{"kind": "line"}\n```'} />
    );
    expect(html).toContain('{&quot;kind&quot;: &quot;line&quot;}');
  });
});
