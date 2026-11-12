import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { TrashItem, TrashPreview } from '@/api/types';
import { getLocale, m } from '@/i18n';

// As in FileViewer.test.tsx: the locale resolves before a window exists.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const state = vi.hoisted(() => ({
  preview: null as TrashPreview | null,
  quizQuestions: [] as unknown[][],
  textURLs: [] as string[],
}));
vi.mock('@/api/hooks', () => ({
  useTrashPreview: () => ({
    data: state.preview,
    isError: false,
    isPending: false,
  }),
}));
// The dialog's frame renders in place (no portal).
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('radix-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('radix-ui')>()),
  Dialog: { Title: ({ children }: { children: ReactNode }) => children },
}));
vi.mock('@/features/quizzes/QuizEditor', () => ({
  QuizReadSplit: ({ questions }: { questions: unknown[] }) => {
    state.quizQuestions.push(questions);
    return null;
  },
}));
vi.mock('./TextView', () => ({
  default: ({ url }: { url: string }) => {
    state.textURLs.push(url);
    return null;
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TrashPreviewDialog } = await import('./TrashPreviewDialog');

afterEach(() => {
  state.preview = null;
  state.quizQuestions.length = 0;
  state.textURLs.length = 0;
});

const item = (title: string): TrashItem =>
  ({
    canRestore: true,
    episodeId: 'ep_1',
    id: 'f_1',
    kind: 'source_file',
    purgeAfter: '2026-12-12T00:00:00Z',
    title,
  }) as TrashItem;

async function render(
  opened: TrashItem,
  onRestore: (item: TrashItem) => void = () => undefined
) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <TrashPreviewDialog
        icon="markdown"
        item={opened}
        onClose={() => {}}
        onRestore={onRestore}
      />
    )
  );
  // The lazy views resolve on later turns.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return root;
}

function savedText(text: string) {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  return btoa(String.fromCharCode(...update));
}

it("shows a trashed text file's saved edits over its bytes", async () => {
  URL.createObjectURL = () => 'blob:saved';
  URL.revokeObjectURL = () => {};
  state.preview = {
    file: { id: 'f_1', kind: 'md', name: 'notes.md' },
    links: { url: 'https://bytes.test/notes.md' },
    source: { state: savedText('# Saved') },
  } as TrashPreview;
  const root = await render(item('notes.md'));
  expect(state.textURLs.at(-1)).toBe('blob:saved');
  root.unmount();
});

it('offers Restore, and only the thumbnail for an Office file', async () => {
  state.preview = {
    file: { id: 'f_1', kind: 'doc', name: 'plan.docx' },
    links: { url: 'https://bytes.test/plan.docx' },
  } as TrashPreview;
  const restored: TrashItem[] = [];
  const root = await render(item('plan.docx'), (value) => restored.push(value));
  const body = document.body.textContent ?? '';
  expect(body).toContain(m.trash_preview_restore_to_open());
  const restore = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === m.trash_restore()
  );
  await act(async () => restore?.click());
  expect(restored.map((value) => value.title)).toEqual(['plan.docx']);
  root.unmount();
});

// The preview's quiz is learner-shaped (no key): it reads in the quiz's read
// split, as the workspace shows it, not as an authored document.
it("shows a trashed quiz's questions in its read split", async () => {
  const question = { id: 'q1', type: 'mcq' };
  state.preview = {
    material: {
      content: {
        value: [
          {
            children: [
              { children: [{ text: '' }], question, type: 'quiz_question' },
            ],
            type: 'quiz',
          },
        ],
      },
      kind: 'quiz',
      title: 'Genetics check-in',
    },
  } as unknown as TrashPreview;
  const root = await render({
    ...item('Genetics check-in'),
    kind: 'material',
  } as TrashItem);
  expect(state.quizQuestions.at(-1)).toEqual([question]);
  root.unmount();
});
