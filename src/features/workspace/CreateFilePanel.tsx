import { useState } from 'react';
import { useCreateMaterial, useMaterials, useWorkspace } from '@/api/hooks';
import type { Material, MaterialKind } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ButtonCard } from '@/components/ui/ButtonCard';
import { DialogClose, DialogFooter } from '@/components/ui/Dialog';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SectionGallery } from '@/components/ui/SectionGallery';
import {
  createMaterialDocument,
  flashcardsNode,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import { nextGenerateTitle } from './generateTitle';

type CreateKind = MaterialKind | 'docx' | 'xlsx' | 'csv' | 'pptx';

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
      {
        icon: materialIconName('mindmap'),
        kind: 'mindmap',
        label: m.generate_kind_mindmap,
      },
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
      { icon: 'csv', kind: 'csv', label: m.source_create_blank_csv },
    ],
  },
  {
    id: 'presentations',
    label: m.source_create_section_presentations,
    tiles: [
      {
        icon: 'ms-powerpoint',
        kind: 'pptx',
        label: m.source_create_blank_pptx,
      },
    ],
  },
];

// Kinds whose document must hold their own element start from these.
// ponytail: mindmap and the office blanks wait on Epo's call for starter
// content and blank file bytes; their tiles show but cannot create yet.
const STARTERS = {
  // Same starter as the editor's diagram block.
  diagram: () => mermaidNode('flowchart LR\n  A --> B'),
  flashcards: () => flashcardsNode([]),
  quiz: () => quizNode({ questions: [] }),
};
const hasStarter = (kind: CreateKind): kind is keyof typeof STARTERS =>
  kind in STARTERS;

/** The Add file dialog's Create tab: pick a kind, then create and open it. */
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
  const { mutate: createMaterial, isPending } = useCreateMaterial(workspaceId);

  const canCreate =
    !isPending &&
    (selected === 'note' || (selected !== null && hasStarter(selected)));

  function create() {
    const open = {
      onSuccess: (material: Material) =>
        onCreated({ id: material.id, kind: 'material' }),
    };
    if (selected === 'note') createMaterial({ kind: 'note' }, open);
    else if (selected && hasStarter(selected)) {
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
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {section.tiles.map((tile) => (
                <ButtonCard
                  aria-pressed={selected === tile.kind}
                  buttonText={tile.label()}
                  className="font-medium! [font-size:var(--body-font-size)]!"
                  componentBeforeText={
                    <FileIcon className="size-5.5" name={tile.icon} />
                  }
                  key={tile.kind}
                  onClick={() => setSelected(tile.kind)}
                />
              ))}
            </div>
          ),
          id: section.id,
          label: section.label(),
        }))}
      />
      <DialogFooter className="shrink-0">
        <DialogClose asChild>
          <Button size="lg" variant="ghost-hover">
            {m.action_cancel()}
          </Button>
        </DialogClose>
        <Button
          disabled={!canCreate}
          onClick={create}
          size="lg"
          variant="accent"
        >
          {m.action_create()}
        </Button>
      </DialogFooter>
    </>
  );
}
