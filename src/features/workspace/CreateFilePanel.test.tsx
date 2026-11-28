import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes
// in before react-dom/client loads (as in FileViewer.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const shown = vi.hoisted(() => ({ titles: [] as string[] }));
const idle = () => ({ isPending: false, mutate: () => {} });
vi.mock('@/api/hooks', async () => {
  // The mocks' /me, which mirrors Go's switch (src/mocks/db.ts).
  const { user } = await import('@/mocks/db');
  return {
    useCreateBlankFile: idle,
    useCreateFlashcardSet: idle,
    useCreateMaterial: idle,
    useCreateQuiz: idle,
    useCreateStandaloneNote: idle,
    useFiles: () => ({ data: [] }),
    useItems: () => ({ data: undefined }),
    useMaterials: () => ({ data: [] }),
    useMe: () => ({ data: user }),
    useWorkspace: () => ({ data: undefined }),
  };
});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }));
vi.mock('@/components/ui/Dialog', () => ({
  DialogFooter: ({ children }: { children: ReactNode }) => children,
  DialogPrimary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/SectionGallery', () => ({
  SectionGallery: ({
    sections,
  }: {
    sections: { content: ReactNode; id: string }[];
  }) => sections.map((section) => section.content),
}));
vi.mock('@/components/app/PreviewCard', () => ({
  PreviewCard: ({ title }: { title: string }) => {
    shown.titles.push(title);
    return null;
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CreateFilePanel, StandaloneCreatePanel } = await import(
  './CreateFilePanel'
);

async function titles(panel: ReactNode) {
  shown.titles.length = 0;
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(panel));
  root.unmount();
  return [...shown.titles];
}

const { FILES_EDITABLE } = await import('@/mocks/db');

it('offers no Blank DOCX or Blank XLSX while /me says files are view-only (Q853 A)', async ({
  skip,
}) => {
  skip(FILES_EDITABLE, 'files are editable');
  const blanks = [m.source_create_blank_docx(), m.source_create_blank_xlsx()];
  for (const panel of [
    <CreateFilePanel key="ws" onCreated={() => {}} workspaceId="ws_1" />,
    <StandaloneCreatePanel key="none" onCreated={() => {}} />,
  ]) {
    const offered = await titles(panel);
    expect(offered).toContain(m.create_kind_note());
    expect(offered.filter((title) => blanks.includes(title))).toEqual([]);
  }
});
