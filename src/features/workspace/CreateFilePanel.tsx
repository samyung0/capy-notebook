import { useState } from 'react';
import {
  useCreateBlankFile,
  useCreateMaterial,
  useFiles,
  useMaterials,
  useWorkspace,
} from '@/api/hooks';
import type { Material, SourceFile } from '@/api/types';
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
  files: SourceFile[]
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
  workspaceId,
  onCreated,
}: {
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
    <>
      <SectionGallery
        className="min-h-0 flex-1"
        label={m.source_create_sections()}
        nav={false}
        sections={SECTIONS.map((section) => ({
          content: (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {section.tiles.map((tile) => (
                <PreviewCard
                  icon={tile.icon}
                  key={tile.kind}
                  onClick={() => setSelected(tile.kind)}
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
      <DialogFooter className="shrink-0">
        <DialogPrimary>
          <Button
            disabled={!canCreate}
            onClick={create}
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
