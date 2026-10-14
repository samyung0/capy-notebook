import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MaterialPreview, QuizPreviewQuestion } from '@/api/types';
import { type Thumbnail, ThumbnailPanel } from './ThumbnailPanel';

const render = (thumbnail: Thumbnail & { small?: boolean }) =>
  renderToStaticMarkup(<ThumbnailPanel icon="pdf" {...thumbnail} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;
const ICON = '#pdf"';

describe('ThumbnailPanel', () => {
  it('shows a page image lazily, dimmed in dark mode, and photos undimmed', () => {
    const page = render({ fileKind: 'pdf', thumbnailUrl: '/t/a.webp' });
    expect(page).toContain('loading="lazy"');
    expect(page).toContain('decoding="async"');
    expect(page).toContain('dark:brightness-[.86]');
    expect(page).toContain('object-top');
    const photo = render({ fileKind: 'image', thumbnailUrl: '/t/b.webp' });
    expect(photo).not.toContain('brightness');
    expect(photo).toContain('object-center');
  });

  it('draws every note block, and an empty note as the icon', () => {
    const note: MaterialPreview = {
      blocks: [
        { level: 1, t: 'h', text: 'Titration' },
        { t: 'p', text: 'Three runs.' },
        { items: ['One'], t: 'ul' },
        { items: [{ done: true, text: 'Weigh' }], t: 'todo' },
        { rows: [['Run'], ['1']], t: 'table' },
        { t: 'math', tex: 'v = \\frac{a}{b}' },
        { t: 'code', text: 'import numpy' },
        { t: 'quote', text: 'Exam tip' },
        { t: 'image' },
      ],
      kind: 'note',
    };
    const html = render({ preview: note });
    for (const part of [
      'pv-h1',
      'pv-p',
      '<li>One</li>',
      'pv-todo pv-done',
      '<th>Run</th>',
      '<td>1</td>',
      'v = \\frac{a}{b}',
      '<pre class="pv-code">import numpy</pre>',
      'pv-quote',
      'pv-img',
    ])
      expect(html).toContain(part);
    expect(html).not.toContain(ICON);
    expect(render({ preview: { blocks: [], kind: 'note' } })).toContain(ICON);
  });

  it('lays out each first-question type without the answer key', () => {
    const quiz = (first: QuizPreviewQuestion) =>
      render({ preview: { first, kind: 'quiz', questionCount: 12 } });
    const mcq = quiz({ options: ['A1', 'B1'], stem: 'Pick', type: 'mcq' });
    expect(count(mcq, 'pv-opt')).toBe(2);
    expect(quiz({ stem: 'Q', type: 'boolean' })).toContain('False');
    expect(quiz({ stem: 'Q', type: 'short' })).toContain('pv-input');
    expect(count(quiz({ stem: 'Q', type: 'open' }), '<i></i>')).toBe(3);
    const matching = quiz({
      prompts: ['Iron', 'Zinc'],
      stem: 'Q',
      type: 'matching',
    });
    expect(matching).toContain('<span>Iron</span><span>Zinc</span>');
    const ordering = quiz({ itemCount: 5, stem: 'Q', type: 'ordering' });
    expect(count(ordering, 'pv-ord')).toBe(1);
    expect(ordering).toContain('5 items');
    expect(quiz({ itemCount: 1, stem: 'Q', type: 'ordering' })).toContain(
      '1 item<'
    );
    expect(
      count(quiz({ stem: 'a\u0001b\u0001c', type: 'gaps' }), '<u></u>')
    ).toBe(2);
    expect(quiz({ hasChart: true, stem: 'Q', type: 'mcq' })).toContain(
      'pv-chart'
    );
  });

  it('shows the row’s count pill, with the icon when there is no preview', () => {
    const html = render({ pill: '12 questions' });
    expect(html).toContain('12 questions');
    expect(html).toContain(ICON);
    expect(render({ pill: '3 cards', small: true })).not.toContain('3 cards');
  });

  it('stacks back cards by count', () => {
    const cards = (cardCount: number, hasImage = false) =>
      render({
        preview: {
          cardCount,
          first: { front: 'Osmosis', hasImage },
          kind: 'flashcards',
        },
      });
    expect(count(cards(1), 'pv-back-')).toBe(0);
    expect(count(cards(2), 'pv-back-')).toBe(1);
    expect(count(cards(24), 'pv-back-')).toBe(2);
    expect(cards(12, true)).toContain('pv-img');
  });

  it('draws supported diagrams and keeps the icon for the rest', () => {
    const diagram = (source: string) =>
      render({ preview: { kind: 'diagram', source } });
    expect(diagram('pie\n  "Fat" : 30\n  "Protein" : 70')).toContain('pv-svg');
    expect(diagram('classDiagram\n  A <|-- B')).toContain(ICON);
    // Previews arrive as open JSON: a diagram without its source keeps the icon.
    expect(
      render({ preview: { kind: 'diagram' } as unknown as MaterialPreview })
    ).toContain(ICON);
  });

  it('shows a text file’s opening lines', () => {
    expect(
      render({ fileKind: 'md', preview: { text: '# Lab notes\n- 25 mL' } })
    ).toContain('<span class="pv-mdh"># Lab notes');
  });

  it('draws a CSV or TSV file as a table, quoted cells whole', () => {
    const csv = render({
      fileKind: 'sheet',
      preview: { text: 'species,note\r\nfrog,"pond, ""east"""\n' },
    });
    expect(csv).toContain('<th>species</th><th>note</th>');
    expect(csv).toContain('<td>frog</td><td>pond, &quot;east&quot;</td>');
    expect(
      render({ fileKind: 'sheet', preview: { text: 'a,b\tc\nd,e\tf' } })
    ).toContain('<th>a,b</th><th>c</th>');
  });
});
