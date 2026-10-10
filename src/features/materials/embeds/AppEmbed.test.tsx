import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Provenance } from '@/api/types';
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

// An embedded quiz or flashcard set shows its own credits inside the note,
// in View and in Edit.
describe('embed credits', () => {
  it('shows the credits of an embedded quiz and set in View', () => {
    expect(render(<AppEmbedView materialId="quiz" refKind="quiz" />)).toContain(
      'Quiz source book'
    );
    expect(
      render(<AppEmbedView materialId="set" refKind="flashcards" />)
    ).toContain('Set source book');
  });

  it('shows them under the embedded editors in Edit', () => {
    expect(
      render(
        <AppEmbedEdit materialId="quiz" onEmpty={() => {}} refKind="quiz" />
      )
    ).toContain('Quiz source book');
    expect(
      render(
        <AppEmbedEdit
          materialId="set"
          onEmpty={() => {}}
          refKind="flashcards"
        />
      )
    ).toContain('Set source book');
  });
});
