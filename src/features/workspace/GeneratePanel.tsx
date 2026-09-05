import { useState } from 'react';
import { useGenerate } from '@/api/hooks';
import type {
  Chapter,
  FlashcardSet,
  GenerateOptions,
  Material,
  Quiz,
  SourceFile,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ButtonCard } from '@/components/ui/ButtonCard';
import type { IconName } from '@/components/ui/Icon';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { GenerateFormDialog, type GenerateMode } from './GenerateFormDialog';

type GenerateResultData =
  | { kind: 'flashcards'; material?: FlashcardSet; cards?: unknown[] }
  | { kind: 'quiz'; quiz?: Quiz }
  | { kind: 'mindmap' | 'diagram'; material?: Material };

const TILES: [GenerateMode, IconName][] = [
  ['flashcards', 'flashcards'],
  ['quiz', 'quiz'],
  ['mindmap', 'workspaces'],
  ['diagram', 'chart'],
];

function tileLabel(mode: GenerateMode): string {
  switch (mode) {
    case 'diagram':
      return m.generate_kind_diagram();
    case 'flashcards':
      return m.generate_flashcards();
    case 'mindmap':
      return m.generate_kind_mindmap();
    case 'quiz':
      return m.generate_quiz();
  }
}

export function GeneratePanel({
  workspaceId,
  workspaceName,
  chapters,
  files,
  existingTitles,
  onOpenItem,
  onGeneratingChange,
}: {
  workspaceId: string;
  workspaceName: string;
  chapters: Chapter[];
  files: SourceFile[];
  existingTitles: string[];
  onOpenItem?: (item: OpenItem) => void;
  onGeneratingChange?: (mode: GenerateMode | null) => void;
}) {
  const { isPending: generateIsPending, mutateAsync: generate } =
    useGenerate(workspaceId);
  const [mode, setMode] = useState<GenerateMode | null>(null);
  const [result, setResult] = useState<GenerateResultData | null>(null);

  async function handleGenerate(opts: GenerateOptions) {
    onGeneratingChange?.(opts.kind);
    setMode(null);
    try {
      const r = (await generate(opts)) as GenerateResultData;
      setResult(r);
      // Reveal the freshly-generated artifact in the center pane.
      const materialId =
        r.kind === 'quiz'
          ? r.quiz?.id
          : r.kind === 'flashcards'
            ? r.material?.id
            : r.material?.id;
      if (materialId) onOpenItem?.({ id: materialId, kind: 'material' });
    } catch {
      // The global mutation handler shows the normalized failure.
    } finally {
      onGeneratingChange?.(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4">
      <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
        {TILES.map(([k, icon]) => (
          <ButtonCard
            buttonText={tileLabel(k)}
            disabled={generateIsPending}
            icon={icon}
            key={k}
            onClick={() => {
              setResult(null);
              setMode(k);
            }}
          />
        ))}
      </div>

      {result && <GenerateResult onOpenItem={onOpenItem} result={result} />}

      {mode && (
        <GenerateFormDialog
          chapters={chapters}
          existingTitles={existingTitles}
          files={files}
          key={mode}
          mode={mode}
          onGenerate={handleGenerate}
          open
          pending={generateIsPending}
          setOpen={(o) => {
            if (!o) setMode(null);
          }}
          workspaceName={workspaceName}
        />
      )}
    </div>
  );
}

function GenerateResult({
  result,
  onOpenItem,
}: {
  result: GenerateResultData;
  onOpenItem?: (item: OpenItem) => void;
}) {
  let label = '';
  let open: OpenItem | null = null;
  if (result.kind === 'quiz') {
    if (result.quiz) {
      label = m.generate_quiz_ready({
        count: result.quiz.questions.length,
        name: result.quiz.name,
      });
      open = { id: result.quiz.id, kind: 'material' };
    }
  } else if (result.kind === 'flashcards') {
    label = m.generate_flashcards_ready({
      count: result.cards?.length ?? 0,
      name: result.material?.name ?? '',
    });
    if (result.material) open = { id: result.material.id, kind: 'material' };
  } else if (result.material) {
    label = m.generate_material_ready({
      kind:
        result.kind === 'mindmap'
          ? m.generate_kind_mindmap()
          : m.generate_kind_diagram(),
      name: result.material.title,
    });
    open = { id: result.material.id, kind: 'material' };
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-hover-bg p-4">
      <p>{label}</p>
      {open && onOpenItem && (
        <Button
          iconRight="arrowRight"
          onClick={() => onOpenItem(open!)}
          size="sm"
          variant="accent"
        >
          {m.action_open()}
        </Button>
      )}
    </div>
  );
}
