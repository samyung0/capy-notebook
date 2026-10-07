// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AnonymousNote } from '@/api/types';
import { MATERIAL_SCHEMA_VERSION } from '@/lib/const';
import { renderSharePage } from './server';

const TEMPLATE =
  '<html lang="en"><head><!--capy-share-head--></head><body><!--capy-share-body--></body></html>';
const text = (value: string) => ({ text: value });
const STATE = /id="share-state">(.*?)<\/script>/;

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
    locale: 'en',
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
