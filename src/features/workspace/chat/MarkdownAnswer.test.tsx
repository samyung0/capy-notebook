import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Citation } from '@/api/types';
import { m } from '@/i18n';
import { withoutMarkers } from './blocks/citeMarkers';
import { loadKatex } from './blocks/math';
import { MarkdownAnswer } from './MarkdownAnswer';
import { parseMarkdownAnswer } from './markdownSegments';

const draw = (content: string, citations?: Citation[]) =>
  renderToStaticMarkup(
    <MarkdownAnswer
      citations={citations}
      complete
      content={content}
      latest={false}
      streaming={false}
    />
  );

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

  it('takes a mermaid fence as a figure', () => {
    expect(
      parseMarkdownAnswer('```mermaid\nflowchart LR\n  A --> B\n```')
    ).toEqual([
      {
        body: 'flowchart LR\n  A --> B',
        closed: true,
        info: '',
        lang: 'mermaid',
        type: 'figure',
      },
    ]);
  });

  it('takes a library figure line as its own segment', () => {
    expect(
      parseMarkdownAnswer(
        'Light reactions:\n![The \\[thylakoid\\] membrane](figure:fig_5_14 "small")\nThen the Calvin cycle.'
      )
    ).toEqual([
      { text: 'Light reactions:', type: 'md' },
      {
        caption: 'The [thylakoid] membrane',
        id: 'fig_5_14',
        type: 'libraryFigure',
      },
      { text: 'Then the Calvin cycle.', type: 'md' },
    ]);
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

describe('withoutMarkers', () => {
  it('cuts citation markers from a copy and leaves code alone', () => {
    const code = '`[#1]` and\n\n```\n[#2,5]\n```';
    expect(withoutMarkers(`Light. [#4]\n\n${code}\nEnd [#2, 5]`)).toBe(
      `Light.\n\n${code}\nEnd`
    );
  });
});

describe('MarkdownAnswer', () => {
  beforeAll(loadKatex);
  const citations = [{ n: 4 }, { n: 2 }] as Citation[];

  it('numbers [#n] markers by the citation list and draws the blocks', () => {
    const html = draw(answer, citations);
    expect(html).not.toContain('[#');
    expect(html).toContain('title="Source 1"');
    expect(html).toContain('title="Source 2"');
    expect(html).toContain('Not glucose');
    expect(html).toContain('Which depth?');
    expect(html).toContain('[!TIP] inside code stays code');
  });

  it('leaves questions to the question block on the latest answer', () => {
    const html = renderToStaticMarkup(
      <MarkdownAnswer complete content={answer} latest streaming={false} />
    );
    expect(html).toContain('Light drives it.');
    expect(html).not.toContain('Which depth?');
  });

  it('never shows an ask fence as code', () => {
    const html = draw('```ask\nnot json\n```');
    expect(html).not.toContain('not json');
  });

  it('draws an html-embed', () => {
    const html = draw(
      '```html-embed title="Supply curve"\n<input type="range">\n```'
    );
    expect(html).toContain('Supply curve');
    expect(html).not.toContain(m.chat_sources());
  });

  it('shows a figure the block refuses as code', () => {
    const html = draw('```plot\n{"kind": "line"}\n```');
    expect(html).toContain('{&quot;kind&quot;: &quot;line&quot;}');
  });

  it('flags a finished answer that stopped inside a figure', () => {
    const content = 'Read this.\n\n```chart\n{"kind":';
    expect(draw(content)).toContain(m.chat_answer_incomplete());
    expect(draw('```chart\n{"kind":')).toContain(m.chat_failed());
    const live = renderToStaticMarkup(
      <MarkdownAnswer
        complete={false}
        content={content}
        latest={false}
        streaming
      />
    );
    expect(live).not.toContain('role="alert"');
  });
});
