import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Provenance } from '@/api/types';
import { MaterialAttributionFooter } from './MaterialAttributionFooter';

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
