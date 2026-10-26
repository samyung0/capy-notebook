import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';
import type { Material } from '@/api/types';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { MaterialContent } from './CenterContent';

const provenance = {
  books: [
    {
      authors: ['Author'],
      excerptIds: ['e_1'],
      id: 'book',
      license: 'CC BY 4.0',
      title: 'Credited source book',
      version: 1,
    },
  ],
};

const block = (type: string, extra: Record<string, unknown>) => ({
  children: [{ text: '' }],
  id: `${type}_1`,
  type,
  ...extra,
});

const materials: Record<string, Partial<Material>> = {
  cards: {
    content: {
      schemaVersion: 1,
      value: [
        {
          children: [
            {
              children: [
                { children: [{ text: 'Card front' }], type: 'p' },
                { children: [{ text: 'Card back' }], type: 'p' },
              ],
              id: 'c1',
              type: 'flashcard',
            },
          ],
          id: 'fc',
          type: 'flashcards',
        },
      ],
    } as Material['content'],
    kind: 'flashcards',
  },
  diagram: {
    content: {
      schemaVersion: 1,
      value: [
        block('mermaid', {
          children: [{ children: [{ text: 'Diagram caption' }], type: 'p' }],
          source: 'graph TD; A-->B',
        }),
      ],
    } as Material['content'],
    kind: 'diagram',
  },
  note: {
    content: {
      schemaVersion: 1,
      value: [{ children: [{ text: 'Note body' }], id: 'p1', type: 'p' }],
    } as Material['content'],
    kind: 'note',
  },
  // A note embedding one credited quiz; the read also names a credited row
  // its content no longer references.
  noteWithEmbed: {
    content: {
      schemaVersion: 1,
      value: [
        { children: [{ text: 'Note body' }], id: 'p1', type: 'p' },
        block('material_ref', { materialId: 'qz_child', refKind: 'quiz' }),
      ],
    } as Material['content'],
    embedCredits: {
      qz_child: {
        ...provenance,
        books: [
          { ...provenance.books[0], id: 'child', title: 'Embedded quiz book' },
        ],
      },
      qz_removed: {
        ...provenance,
        books: [
          { ...provenance.books[0], id: 'gone', title: 'Removed quiz book' },
        ],
      },
    },
    kind: 'note',
  },
  quiz: {
    content: { schemaVersion: 1, value: [] } as Material['content'],
    kind: 'quiz',
  },
};

vi.mock('@/api/hooks', async () => {
  const { ApiError } = await import('@/api/client');
  return {
    useMaterial: (id: string) =>
      id === 'unreadable'
        ? {
            data: undefined,
            error: new ApiError(422, 'Unprocessable Entity', undefined, {
              code: 'material_content_unreadable',
            }),
            isLoading: false,
          }
        : {
            data: {
              capabilities: { canEdit: false, canEditContent: false },
              id,
              provenance,
              revision: 1,
              title: `Title ${id}`,
              workspaceId: 'ws',
              ...materials[id],
            },
            error: null,
            isLoading: false,
          },
  };
});
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('./MaterialPreview', () => ({
  MaterialPreview: ({ content }: { content: Material['content'] }) => (
    <div>{JSON.stringify(content).includes('Note body') && 'Note body'}</div>
  ),
}));

async function render(node: ReactNode) {
  const { prelude } = await prerenderToNodeStream(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>{node}</ThemeProvider>
    </QueryClientProvider>
  );
  let html = '';
  for await (const chunk of prelude) html += chunk;
  return html;
}

/** The markup of the panel's scrolling element. */
function scrollArea(html: string) {
  const open = html.lastIndexOf('<div', html.indexOf('overflow-auto'));
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open, tags.lastIndex);
  }
  throw new Error('the scroll area does not close');
}

// The credits scroll with the material, at the end of its document, rather
// than staying pinned under the panel.
describe('material attribution placement', () => {
  it.each([
    ['note', 'Note body'],
    ['cards', 'Card front'],
    ['quiz', 'Title quiz'],
    ['diagram', 'Diagram caption'],
  ])('ends the %s view inside its scroll area', async (id, content) => {
    const html = await render(
      <MaterialContent
        allowExternalAssets={false}
        centerQuiz={false}
        forceReadOnly={false}
        materialId={id}
        mode="view"
        onEditorStatusChange={() => {}}
      />
    );
    const area = scrollArea(html);
    expect(area.indexOf('Credited source book')).toBeGreaterThan(
      area.indexOf(content)
    );
    expect(html.indexOf('Credited source book')).toBe(
      html.lastIndexOf('Credited source book')
    );
    // A note or diagram ends with the full footer; a quiz or flashcard set
    // with its collapsed Sources line.
    expect(area.includes('<footer')).toBe(id === 'note' || id === 'diagram');
  });
});

// The note's footer credits its own sources then each embed its content holds
// (the read's embedCredits until the embed's own read lands), never one it
// no longer holds.
it('credits the embeds the note holds in its footer', async () => {
  const html = await render(
    <MaterialContent
      allowExternalAssets={false}
      centerQuiz={false}
      forceReadOnly={false}
      materialId="noteWithEmbed"
      mode="view"
      onEditorStatusChange={() => {}}
    />
  );
  const footer = html.slice(html.lastIndexOf('<footer'));
  expect(footer.indexOf('Embedded quiz book')).toBeGreaterThan(
    footer.indexOf('Credited source book')
  );
  expect(footer).not.toContain('Removed quiz book');
});

// A quiz or set whose stored content the rules refuse is left out of the study
// pages; opening it shows the center file error (Epo 2026-10-20).
it('shows the center file error, named by the kind it opened, for a material whose content cannot be read', async () => {
  const html = await render(
    <MaterialContent
      allowExternalAssets={false}
      centerQuiz={false}
      forceReadOnly={false}
      kind="quiz"
      materialId="unreadable"
      mode="view"
      onEditorStatusChange={() => {}}
    />
  );
  expect(html).toContain('data-error-surface="panel"');
  expect(html).toContain('This quiz could not be loaded');
});
