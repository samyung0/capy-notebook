import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MaterialPreview, QuizPreviewQuestion } from '@/api/types';
import { type Thumbnail, ThumbnailPanel } from './ThumbnailPanel';

const render = (thumbnail: Thumbnail) =>
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

  it('lays out each first-question type under the count pill', () => {
    const quiz = (first: QuizPreviewQuestion, questionCount = 12) =>
      render({ preview: { first, kind: 'quiz', questionCount } });
    const mcq = quiz({ options: ['A1', 'B1'], stem: 'Pick', type: 'mcq' });
    expect(mcq).toContain('12 questions');
    expect(count(mcq, 'pv-opt')).toBe(2);
    expect(quiz({ stem: 'Q', type: 'boolean' }, 1)).toContain('1 question');
    expect(quiz({ stem: 'Q', type: 'boolean' })).toContain('False');
    expect(
      count(quiz({ options: ['x'], stem: 'Q', type: 'multi' }), 'pv-box')
    ).toBe(1);
    expect(quiz({ stem: 'Q', type: 'short' })).toContain('pv-input');
    expect(count(quiz({ stem: 'Q', type: 'open' }), '<i></i>')).toBe(3);
    expect(
      count(
        quiz({
          pairs: [
            ['a', 'b'],
            ['c', 'd'],
          ],
          stem: 'Q',
          type: 'matching',
        }),
        'pv-pair'
      )
    ).toBe(2);
    expect(
      count(
        quiz({ items: ['1', '2', '3'], stem: 'Q', type: 'ordering' }),
        'pv-ord'
      )
    ).toBe(3);
    expect(
      count(quiz({ stem: 'a\u0001b\u0001c', type: 'gaps' }), '<u></u>')
    ).toBe(2);
    expect(quiz({ hasChart: true, stem: 'Q', type: 'mcq' })).toContain(
      'pv-chart'
    );
  });

  it('stacks back cards by count and names the count', () => {
    const cards = (cardCount: number, hasImage = false) =>
      render({
        preview: {
          cardCount,
          first: { front: 'Osmosis', hasImage },
          kind: 'flashcards',
        },
      });
    expect(count(cards(1), 'pv-back-')).toBe(0);
    expect(cards(1)).toContain('1 card');
    expect(count(cards(2), 'pv-back-')).toBe(1);
    expect(count(cards(24), 'pv-back-')).toBe(2);
    expect(cards(24)).toContain('24 cards');
    expect(cards(12, true)).toContain('pv-img');
  });

  it('draws supported diagrams and keeps the icon for the rest', () => {
    const diagram = (source: string) =>
      render({ preview: { kind: 'diagram', source } });
    expect(diagram('pie\n  "Fat" : 30\n  "Protein" : 70')).toContain('pv-svg');
    expect(diagram('classDiagram\n  A <|-- B')).toContain(ICON);
  });

  it('shows a text file’s opening lines', () => {
    expect(
      render({ fileKind: 'md', preview: { text: '# Lab notes\n- 25 mL' } })
    ).toContain('<span class="pv-mdh"># Lab notes');
  });
});
