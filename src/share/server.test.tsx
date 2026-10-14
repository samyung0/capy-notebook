// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AnonymousNote } from '@/api/types';
import { parseMaterialDocument } from '@/features/materials/document';
import { MATERIAL_SCHEMA_VERSION } from '@/lib/const';
import everyBlock from '../../server/internal/materialdoc/testdata/every-block-note.json';
import { renderSharePage, renderSharePagePieces } from './server';

const TEMPLATE =
  '<html lang="en"><head><!--capy-share-head--></head><body><!--capy-share-body--></body></html>';
const text = (value: string) => ({ text: value });
const STATE = /id="share-state">(.*?)<\/script>/;
/** The host inside a fetching or navigating attribute (a meta description that
 * quotes the source as text is harmless). */
const EVIL_IN_ATTRIBUTE =
  /(?:style|src|srcset|href|poster|background)="[^"]*evil\.test/i;
const EVENT_HANDLER = /<[^>]*\son[a-z]+\s*=/i;
const JSON_LD = /<script type="application\/ld\+json">(.*?)<\/script>/;
const IMAGE_PRELOAD = /<link rel="preload" as="image"[^>]*\/>/g;
const REACT_ID = /_(?:s\d+-)?R_[0-9a-z]+_/g;

const note: AnonymousNote = {
  author: { name: 'Mia' },
  content: {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    value: [
      { children: [text('Cells')], id: 'h', type: 'h1' },
      {
        children: [
          text('Energy '),
          {
            children: [text('')],
            id: 'ie',
            texExpression: 'E=mc^2',
            type: 'inline_equation',
          },
          text(''),
        ],
        id: 'p',
        type: 'p',
      },
      {
        children: [text('')],
        id: 'eq',
        texExpression: '\\frac{a}{b}',
        type: 'equation',
      },
      {
        children: [text('')],
        id: 'v',
        provider: 'youtube',
        type: 'video',
        videoId: 'dQw4w9WgXcQ',
      },
      { assetId: 'asset_1', children: [text('')], id: 'img', type: 'img' },
      {
        children: [text('')],
        id: 'ref',
        materialId: 'mat_set',
        refKind: 'flashcards',
        type: 'material_ref',
      },
      {
        block: {
          board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
          description: 'A line',
          elements: [],
          height: 300,
          image: {
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"></svg>',
          },
          type: 'graph',
          width: 400,
        },
        children: [text('')],
        id: 'graph',
        type: 'graph',
      },
      {
        caption: 'Osmosis',
        children: [text('')],
        html: '<p>hi</p>',
        id: 'html',
        type: 'html_embed',
      },
    ],
  },
  embeds: [
    {
      cards: [{ back: 'Powerhouse', front: 'Mitochondria', id: 'c1' }],
      id: 'mat_set',
      kind: 'flashcards',
    },
  ],
  id: 'mat_note',
  name: 'Cells',
  privacy: 'public',
  updatedAt: '2026-10-04T10:00:00Z',
} as unknown as AnonymousNote;

describe('renderSharePage', () => {
  const html = renderSharePage({
    canonical: 'https://app.example.test/share/notes/mat_note.sig',
    page: { kind: 'notes', note, token: 'mat_note.sig' },
    template: TEMPLATE,
  });

  it('renders a note to HTML with math as static markup and its stylesheet', () => {
    expect(html).toContain('<title>Cells | Capy Notebook</title>');
    // The first heading repeats the title, so only the page title remains.
    expect(html.match(/>Cells</g)).toHaveLength(1);
    expect(html).toContain('class="ML__latex"');
    expect(html).toContain('href="/mathlive/mathlive-static.css"');
  });

  it('leaves video players, images and embeds to the browser', () => {
    // The poster only: YouTube's player loads when clicked.
    expect(html).toContain('data-youtube-play="dQw4w9WgXcQ"');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('src="/p/notes/mat_note.sig/assets/asset_1"');
    expect(html).toContain('data-island="media"');
    // Embeds render on the server too, then hydrate from the state.
    expect(html).toContain('data-island="embed"');
    expect(html).toContain('Mitochondria');
    // Charts and graphs hydrate for their double-click preview.
    expect(html).toContain('data-island="figure"');
    expect(html).toContain('data-island="html"');
    // Visitors don't get an interactive block's View source.
    expect(html).not.toContain('View source');
  });

  it('describes the note for search and link previews, without an image', () => {
    expect(html).toContain('<meta name="description" content="Energy');
    expect(html).toContain('<meta name="robots" content="index, follow">');
    expect(html).toContain(
      '<meta property="article:modified_time" content="2026-10-04T10:00:00Z">'
    );
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain('og:image');
    const jsonLd = JSON.parse(html.match(JSON_LD)?.[1] ?? 'null');
    expect(jsonLd).toMatchObject({
      '@type': 'Article',
      author: { name: 'Mia' },
      dateModified: '2026-10-04T10:00:00Z',
      name: 'Cells',
    });
  });

  // Security regression: a shared note's formula is rendered with no event
  // handler and no paint/background fetch (inertTex draws the HTML commands as
  // text; the tripwire is the backstop).
  const formulaPage = (texExpression: string) =>
    renderSharePage({
      canonical: 'https://app.example.test/share/notes/mat_note.sig',
      page: {
        kind: 'notes',
        note: {
          ...note,
          content: {
            schemaVersion: MATERIAL_SCHEMA_VERSION,
            value: [
              {
                children: [text('')],
                id: 'eq',
                texExpression,
                type: 'equation',
              },
            ],
          },
        } as AnonymousNote,
        token: 'mat_note.sig',
      },
      template: TEMPLATE,
    });

  it('renders a formula with no handler or fetch', () => {
    const page = formulaPage(
      '\\htmlStyle{background:url(https://evil.test/a)}{x}'
    );
    expect(page).toContain('class="ML__latex"');
    // The command's URL never reaches an attribute value or an event handler;
    // it draws as plain text, and the page's own CSS keeps its `url(`.
    expect(page).not.toMatch(EVIL_IN_ATTRIBUTE);
    expect(page).not.toMatch(EVENT_HANDLER);
  });

  it('hands the browser only what its islands need', () => {
    const state = JSON.parse(html.match(STATE)?.[1] ?? 'null');
    expect(state).toEqual({
      embeds: note.embeds,
      kind: 'notes',
      token: 'mat_note.sig',
    });
  });
});

describe('a streamed note', () => {
  const everyBlockNote = {
    ...note,
    // Parsed once, as stored notes are: an element without an id would get
    // a new random one in every render.
    content: parseMaterialDocument(everyBlock),
    name: 'Every block',
  } as unknown as AnonymousNote;
  const render = (sliceBytes: { first: number; rest: number }) =>
    renderSharePagePieces({
      canonical: 'https://app.example.test/share/notes/mat_note.sig',
      page: { kind: 'notes', note: everyBlockNote, token: 'mat_note.sig' },
      sliceBytes,
      template: TEMPLATE,
    });

  it('is the same page whether its blocks render at once or one by one', () => {
    const whole = render({
      first: Number.POSITIVE_INFINITY,
      rest: Number.POSITIVE_INFINITY,
    });
    expect(whole.rest).toHaveLength(0);
    const pieces = render({ first: 1, rest: 1 });
    expect(pieces.rest.length).toBeGreaterThan(20);
    const joined =
      pieces.first + pieces.rest.map((piece) => piece()).join('') + pieces.last;
    // React hoists a preload for each image to the top of the page; a
    // streamed page has them only for the blocks it sends first, so later
    // images do not compete with the first screen. Each slice's React ids
    // carry its own prefix.
    const comparable = (html: string) =>
      html.replaceAll(IMAGE_PRELOAD, '').replaceAll(REACT_ID, '_ID_');
    expect(comparable(joined)).toBe(comparable(whole.first));
    const ids = [...joined.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
