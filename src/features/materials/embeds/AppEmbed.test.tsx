import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import type { Provenance } from '@/api/types';
import type { MaterialRefKind } from '@/features/materials/document';
import { m } from '@/i18n';
import { AppEmbedEdit, AppEmbedView } from './AppEmbed';

const credit = (title: string): Provenance => ({
  books: [
    {
      authors: ['Author'],
      excerptIds: ['e_1'],
      id: title,
      license: 'CC BY 4.0',
      title,
      version: 1,
    },
  ],
});

const question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { type: 'boolean' },
      blocks: [{ text: 'True?', type: 'text' }],
      id: 'q1:part:1',
      marks: 1,
    },
  ],
  stem: [
    { height: 10, image: { assetId: 'asset_quiz' }, type: 'image', width: 10 },
  ],
};

vi.mock('@/api/hooks', () => ({
  useCheckQuizQuestion: () => ({ mutateAsync: vi.fn() }),
  useMaterial: () => ({
    data: {
      content: {
        schemaVersion: 1,
        value: [
          {
            children: [
              {
                children: [
                  { children: [{ text: 'Front' }], type: 'p' },
                  { children: [{ text: 'Back' }], type: 'p' },
                ],
                id: 'c1',
                image: { assetId: 'asset_card' },
                type: 'flashcard',
              },
            ],
            id: 'fc',
            type: 'flashcards',
          },
        ],
      },
      id: 'set',
      provenance: credit('Set source book'),
      removedAssetIds: ['asset_card'],
      revision: 1,
    },
    isError: false,
    isPending: false,
  }),
  // The live editors wait for the account before joining their rooms.
  useMe: () => ({ data: undefined }),
  useQuiz: () => ({
    data: {
      id: 'quiz',
      provenance: credit('Quiz source book'),
      questions: [question],
      removedAssetIds: ['asset_quiz'],
    },
    isError: false,
    isPending: false,
  }),
}));

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );

/** The embed's own credits, behind a collapsed "Sources (1)" line. */
const credited = (html: string, book: string) =>
  html.includes(book) &&
  html.includes(m.material_attribution_sources({ count: 1 })) &&
  html.includes('aria-expanded="false"');

// An embedded quiz or flashcard set shows its own credits inside the note,
// in View and in Edit, behind one collapsed "Sources (n)" line.
describe('embed credits', () => {
  it('shows the credits of an embedded quiz and set in View', () => {
    expect(
      credited(
        render(<AppEmbedView materialId="quiz" refKind="quiz" />),
        'Quiz source book'
      )
    ).toBe(true);
    expect(
      credited(
        render(<AppEmbedView materialId="set" refKind="flashcards" />),
        'Set source book'
      )
    ).toBe(true);
  });

  it('shows them under the embedded editors in Edit', () => {
    expect(
      credited(
        render(
          <AppEmbedEdit materialId="quiz" onEmpty={() => {}} refKind="quiz" />
        ),
        'Quiz source book'
      )
    ).toBe(true);
    expect(
      credited(
        render(
          <AppEmbedEdit
            materialId="set"
            onEmpty={() => {}}
            refKind="flashcards"
          />
        ),
        'Set source book'
      )
    ).toBe(true);
  });
});

// An embedded quiz or set names the images its uploader deleted in its own
// response, not the note's (M16), and shows them as removed.
it("shows an embed's own removed images as removed", () => {
  for (const kind of ['quiz', 'flashcards'] as const) {
    expect(render(<AppEmbedView materialId={kind} refKind={kind} />)).toContain(
      m.media_image_removed()
    );
  }
});

// Every item kind the embed catalog lists draws as itself in View and Edit;
// a kind it adds needs a case in AppEmbed and here.
describe('embed kinds', () => {
  const books: Record<string, string> = {
    flashcards: 'Set source book',
    quiz: 'Quiz source book',
  };
  const kinds = EMBED_CATALOG.embeds
    .filter((embed) => embed.class === 'item')
    .map((embed) => embed.kind as MaterialRefKind);

  it.each(kinds)('draws a %s as itself', (kind) => {
    const book = books[kind];
    expect(book, `how a ${kind} embed draws`).toBeDefined();
    const others = Object.values(books).filter((other) => other !== book);
    for (const html of [
      render(<AppEmbedView materialId={kind} refKind={kind} />),
      render(
        <AppEmbedEdit materialId={kind} onEmpty={() => {}} refKind={kind} />
      ),
    ]) {
      expect(credited(html, book)).toBe(true);
      for (const other of others) expect(html).not.toContain(other);
    }
  });

  it('fails loudly on a kind it does not draw', () => {
    expect(() =>
      render(
        <AppEmbedView materialId="x" refKind={'timeline' as MaterialRefKind} />
      )
    ).toThrow('timeline');
  });
});
