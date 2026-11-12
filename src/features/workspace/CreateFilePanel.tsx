import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  useCreateBlankFile,
  useCreateFlashcardSet,
  useCreateMaterial,
  useCreateQuiz,
  useCreateStandaloneNote,
  useFiles,
  useItems,
  useMaterials,
  useWorkspace,
} from '@/api/hooks';
import type { Material } from '@/api/types';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Button } from '@/components/ui/Button';
import { DialogFooter, DialogPrimary } from '@/components/ui/Dialog';
import type { FileIconName } from '@/components/ui/FileIcon';
import { SectionGallery } from '@/components/ui/SectionGallery';
import {
  createMaterialDocument,
  flashcardsNode,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import type { OpenItem } from '@/features/materials/openItem';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import { nextGenerateTitle } from './generateTitle';
import { TEMPLATE_THUMBNAILS } from './templatePreviews';

type CreateKind = keyof typeof TEMPLATE_THUMBNAILS;

// Office files say Blank so templates can sit beside them later.
const SECTIONS: {
  id: string;
  label: () => string;
  tiles: { kind: CreateKind; icon: FileIconName; label: () => string }[];
}[] = [
  {
    id: 'materials',
    label: m.source_create_section_materials,
    tiles: [
      {
        icon: materialIconName('note'),
        kind: 'note',
        label: m.create_kind_note,
      },
      { icon: materialIconName('quiz'), kind: 'quiz', label: m.generate_quiz },
      {
        icon: materialIconName('flashcards'),
        kind: 'flashcards',
        label: m.generate_flashcards,
      },
      // Mindmap is hidden until it has a starter source (Epo 2026-10-25).
      {
        icon: materialIconName('diagram'),
        kind: 'diagram',
        label: m.generate_kind_diagram,
      },
    ],
  },
  {
    id: 'documents',
    label: m.source_create_section_documents,
    tiles: [
      { icon: 'ms-word', kind: 'docx', label: m.source_create_blank_docx },
    ],
  },
  {
    id: 'spreadsheets',
    label: m.source_create_section_spreadsheets,
    tiles: [
      { icon: 'ms-excel', kind: 'xlsx', label: m.source_create_blank_xlsx },
    ],
  },
  // CSV and PPTX are hidden until the Office engine has starters for them.
];

// Kinds whose document must hold their own element start from these.
const STARTERS = {
  // Same starter as the editor's diagram block.
  diagram: () => ({
    ...mermaidNode('flowchart LR\n  A --> B'),
    theme: useNoteEditorPrefs.getState().mermaidTheme,
  }),
  flashcards: () => flashcardsNode([]),
  quiz: () => quizNode({ questions: [] }),
};
const hasStarter = (kind: CreateKind): kind is keyof typeof STARTERS =>
  kind in STARTERS;

/** Blank Office files come from the Office engine's starter (the server's
 * blank file route); their names count up like Generate's titles. */
const BLANK_NAMES = {
  docx: m.create_blank_docx_name,
  xlsx: m.create_blank_xlsx_name,
};
const isBlankOffice = (kind: CreateKind): kind is keyof typeof BLANK_NAMES =>
  kind in BLANK_NAMES;

function nextBlankName(
  format: keyof typeof BLANK_NAMES,
  files: { name: string }[]
): string {
  const taken = new Set(files.map((file) => file.name.toLowerCase()));
  const base = BLANK_NAMES[format]();
  let n = 1;
  while (taken.has(`${base} ${n}.${format}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** The Add file dialog's Create tab: pick a template card, then create and
 * open it. */
export function CreateFilePanel({
  aboveFooter,
  workspaceId,
  onCreated,
}: {
  /** Files' Add to field, right above the footer. */
  aboveFooter?: ReactNode;
  workspaceId: string;
  onCreated: (item: OpenItem) => void;
}) {
  const [selected, setSelected] = useState<CreateKind | null>(null);
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const { data: files } = useFiles(workspaceId, { errorBoundary: false });
  const { mutate: createMaterial, isPending: materialPending } =
    useCreateMaterial(workspaceId);
  const { mutate: createBlank, isPending: blankPending } =
    useCreateBlankFile(workspaceId);

  const canCreate =
    !materialPending &&
    !blankPending &&
    selected !== null &&
    (selected === 'note' || hasStarter(selected) || isBlankOffice(selected));

  function create() {
    const open = {
      onSuccess: (material: Material) =>
        onCreated({ id: material.id, kind: 'material' }),
    };
    if (selected === 'note') createMaterial({ kind: 'note' }, open);
    else if (selected && isBlankOffice(selected)) {
      createBlank(
        { format: selected, name: nextBlankName(selected, files ?? []) },
        { onSuccess: (file) => onCreated({ id: file.id, kind: 'file' }) }
      );
    } else if (selected && hasStarter(selected)) {
      createMaterial(
        {
          content: createMaterialDocument([STARTERS[selected]()]),
          kind: selected,
          // Generate's "{workspace} quiz {n}" names keep titles unique.
          title: nextGenerateTitle(
            selected,
            workspace?.name ?? '',
            (materials ?? []).map((material) => material.title)
          ),
        },
        open
      );
    }
  }

  return (
    <CreateGallery
      aboveFooter={aboveFooter}
      canCreate={canCreate}
      onCreate={create}
      onSelect={setSelected}
      sections={SECTIONS}
      selected={selected}
    />
  );
}

/** No workspace (Epo 2026-11-12): the Create tab without what needs one (a
 * diagram), the blocks made as Files' New block made them and opened on
 * their own pages, the blank Office files as standalone files. */
const STANDALONE_SECTIONS = SECTIONS.map((section) => ({
  ...section,
  tiles: section.tiles.filter((tile) => tile.kind !== 'diagram'),
}));

export function StandaloneCreatePanel({
  aboveFooter,
  onCreated,
}: {
  aboveFooter?: ReactNode;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<CreateKind | null>(null);
  const { mutate: createNote, isPending: notePending } =
    useCreateStandaloneNote();
  const { mutate: createQuiz, isPending: quizPending } = useCreateQuiz();
  const { mutate: createFlashcardSet, isPending: setPending } =
    useCreateFlashcardSet();
  const { mutate: createBlank, isPending: blankPending } =
    useCreateBlankFile(null);
  // Blank names count up past the standalone Office files on the first page.
  const { data: blanks } = useItems({
    kinds: ['doc', 'sheet'],
    locations: ['standalone'],
  });
  const openMaterial = (material: { id: string }) => {
    onCreated();
    void navigate({
      params: { materialId: material.id },
      to: '/materials/$materialId',
    });
  };
  function create() {
    if (selected === 'note') createNote({}, { onSuccess: openMaterial });
    else if (selected === 'quiz')
      createQuiz(
        { name: m.quiz_untitled(), questions: [] },
        { onSuccess: openMaterial }
      );
    else if (selected === 'flashcards')
      createFlashcardSet(
        { color: 'purple', name: m.flashcards_new_flashcards() },
        {
          onSuccess: (set) => {
            onCreated();
            void navigate({
              params: { flashcardSetId: set.id },
              to: '/flashcards/$flashcardSetId',
            });
          },
        }
      );
    else if (selected && isBlankOffice(selected)) {
      const taken = (blanks?.pages[0]?.items ?? []).flatMap((item) =>
        item.type === 'file' ? [item.file] : []
      );
      createBlank(
        { format: selected, name: nextBlankName(selected, taken) },
        {
          onSuccess: (file) => {
            onCreated();
            void navigate({
              params: { fileId: file.id },
              to: '/files/$fileId',
            });
          },
        }
      );
    }
  }
  return (
    <CreateGallery
      aboveFooter={aboveFooter}
      canCreate={
        selected !== null &&
        !(notePending || quizPending || setPending || blankPending)
      }
      onCreate={create}
      onSelect={setSelected}
      sections={STANDALONE_SECTIONS}
      selected={selected}
    />
  );
}

/** The template cards by section, then Create. */
function CreateGallery({
  aboveFooter,
  canCreate,
  onCreate,
  onSelect,
  sections,
  selected,
}: {
  aboveFooter: ReactNode;
  canCreate: boolean;
  onCreate: () => void;
  onSelect: (kind: CreateKind) => void;
  sections: typeof SECTIONS;
  selected: CreateKind | null;
}) {
  return (
    <>
      <SectionGallery
        className="min-h-0 flex-1"
        label={m.source_create_sections()}
        nav={false}
        sections={sections.map((section) => ({
          content: (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {section.tiles.map((tile) => (
                <PreviewCard
                  icon={tile.icon}
                  key={tile.kind}
                  onClick={() => onSelect(tile.kind)}
                  selected={selected === tile.kind}
                  thumbnail={TEMPLATE_THUMBNAILS[tile.kind]()}
                  title={tile.label()}
                />
              ))}
            </div>
          ),
          id: section.id,
          label: section.label(),
        }))}
      />
      {aboveFooter}
      <DialogFooter className="shrink-0">
        <DialogPrimary>
          <Button
            disabled={!canCreate}
            onClick={onCreate}
            size="lg"
            variant="accent"
          >
            {m.action_create()}
          </Button>
        </DialogPrimary>
      </DialogFooter>
    </>
  );
}
