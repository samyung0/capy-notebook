import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';
import type { Material } from '@/api/types';
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
  quiz: {
    content: { schemaVersion: 1, value: [] } as Material['content'],
    kind: 'quiz',
  },
};

vi.mock('@/api/hooks', () => ({
  useMaterial: (id: string) => ({
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
  }),
}));
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
  const { prelude } = await prerenderToNodeStream(node);
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
