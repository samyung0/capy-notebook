import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Provenance } from '@/api/types';
import { m } from '@/i18n';
import {
  MaterialAttributionFooter,
  QuestionCreditNote,
  SourcesLine,
} from './MaterialAttributionFooter';

const provenance: Provenance = {
  books: [
    {
      authors: ['Diez', 'Çetinkaya-Rundel'],
      edition: '4th edition',
      excerptIds: ['e_1', 'e_2'],
      id: 'ahss',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourceUrl: 'https://openintro.org/ahss',
      title: 'Advanced High School Statistics',
      version: 2,
    },
  ],
  license: 'CC BY-SA 4.0',
};

describe('MaterialAttributionFooter', () => {
  it('credits each book with its licence and source link', () => {
    const html = renderToStaticMarkup(
      <MaterialAttributionFooter provenance={provenance} />
    );

    expect(html).toContain(
      'Advanced High School Statistics (4th edition, version 2)'
    );
    expect(html).toContain('Diez, Çetinkaya-Rundel');
    expect(html).toContain('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(html).toContain('https://openintro.org/ahss');
    expect(html).toContain('This material is licensed CC BY-SA 4.0.');
  });

  it('credits a web page with its publisher, retrieval date and link', () => {
    const html = renderToStaticMarkup(
      <MaterialAttributionFooter
        provenance={{
          books: [],
          web: [
            {
              authors: ['Writer'],
              license: 'CC BY 4.0',
              publisher: 'Open Journal',
              retrievedAt: '2026-10-02',
              title: 'An essay',
              url: 'https://open.example/essay',
            },
          ],
        }}
      />
    );

    expect(html).toContain('An essay (Open Journal, retrieved 2026-10-02)');
    expect(html).toContain('Writer');
    expect(html).toContain('https://open.example/essay');
  });

  it('still names the book version when the book has no edition', () => {
    const html = renderToStaticMarkup(
      <MaterialAttributionFooter
        provenance={{ books: [{ ...provenance.books[0], edition: '' }] }}
      />
    );

    expect(html).toContain('Advanced High School Statistics (version 2)');
  });

  it('only links a licence or source that is a web address', () => {
    const html = renderToStaticMarkup(
      <MaterialAttributionFooter
        provenance={{
          books: [
            {
              ...provenance.books[0],
              licenseUrl: 'CC BY-SA 4.0 (see the back cover)',
              sourceUrl: 'javascript:alert(1)',
            },
          ],
        }}
      />
    );

    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('CC BY-SA 4.0');
  });

  it('renders nothing for a material with no library sources', () => {
    expect(
      renderToStaticMarkup(<MaterialAttributionFooter provenance={undefined} />)
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <MaterialAttributionFooter provenance={{ books: [] }} />
      )
    ).toBe('');
  });
});

describe('QuestionCreditNote', () => {
  it('credits a copied bank question under it, and only that one', () => {
    const credits: Provenance = {
      books: [],
      questions: {
        q1: {
          books: [],
          web: [
            {
              authors: ['Writer'],
              license: 'CC BY 4.0',
              retrievedAt: '2026-10-02',
              title: 'An essay',
              url: 'https://open.example/essay',
            },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(
      <QuestionCreditNote credit={credits.questions?.q1} />
    );
    expect(html).toContain('An essay (retrieved 2026-10-02) by Writer');
    expect(html).toContain('https://open.example/essay');
    expect(
      renderToStaticMarkup(
        <QuestionCreditNote credit={credits.questions?.q2} />
      )
    ).toBe('');
    // A quiz of copied questions has no footer of its own.
    expect(
      renderToStaticMarkup(<MaterialAttributionFooter provenance={credits} />)
    ).toBe('');
  });
});

const CONTROLS = /aria-controls="([^"]+)"/;

// A quiz's or flashcard set's credits: one collapsed line naming the count,
// a button that controls the list it expands.
describe('SourcesLine', () => {
  it('starts collapsed, counts the sources and controls the hidden list', () => {
    const html = renderToStaticMarkup(
      <SourcesLine
        provenance={{
          ...provenance,
          web: [
            {
              authors: [],
              license: 'CC BY 4.0',
              retrievedAt: '2026-10-02',
              title: 'An essay',
              url: 'https://open.example/essay',
            },
          ],
        }}
      />
    );
    expect(html).toContain(m.material_attribution_sources({ count: 2 }));
    expect(html).toContain('aria-expanded="false"');
    const controls = html.match(CONTROLS)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toMatch(
      new RegExp(
        `<div[^>]*hidden=""[^>]*id="${controls}"|<div[^>]*id="${controls}"[^>]*hidden=""`
      )
    );
    // The list is there for the button to show: both sources and the licence.
    expect(html).toContain('Advanced High School Statistics');
    expect(html).toContain('An essay');
    expect(html).toContain('This material is licensed CC BY-SA 4.0.');
  });

  it('renders nothing without sources', () => {
    expect(
      renderToStaticMarkup(<SourcesLine provenance={{ books: [] }} />)
    ).toBe('');
    expect(renderToStaticMarkup(<SourcesLine provenance={undefined} />)).toBe(
      ''
    );
  });
});
