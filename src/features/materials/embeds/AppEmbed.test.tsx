import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Provenance } from '@/api/types';
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
  stem: [],
};

vi.mock('@/api/hooks', () => ({
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
      revision: 1,
    },
    isError: false,
    isPending: false,
  }),
  useQuiz: () => ({
    data: {
      id: 'quiz',
      provenance: credit('Quiz source book'),
      questions: [question],
    },
    isError: false,
    isPending: false,
  }),
  useQuizEdit: () => ({ data: undefined }),
  useSubmitAttempt: () => ({ mutateAsync: vi.fn() }),
  useUpdateFlashcardContent: () => ({ mutateAsync: vi.fn() }),
  useUpdateQuizContent: () => ({ mutateAsync: vi.fn() }),
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
