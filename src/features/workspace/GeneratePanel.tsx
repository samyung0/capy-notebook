import { useState } from 'react';
import { useGenerate } from '@/api/hooks';
import type {
  Chapter,
  Deck,
  GenerateOptions,
  Material,
  Quiz,
  SourceFile,
} from '@/api/types';
import { Button, Icon, type IconName } from '@/components/ui';
import { userToast } from '@/components/ui/userToast';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { GenerateFormDialog, type GenerateMode } from './GenerateFormDialog';

type GenerateResultData =
  | { kind: 'flashcards'; deck?: Deck; cards?: unknown[] }
  | { kind: 'quiz'; quiz?: Quiz }
  | { kind: 'mindmap' | 'diagram'; material?: Material };

const TILES: [GenerateMode, IconName, string][] = [
  ['flashcards', 'flashcards', m.generate_flashcards()],
  ['quiz', 'quiz', m.generate_quiz()],
  ['mindmap', 'workspaces', 'Mindmap'],
  ['diagram', 'chart', 'Diagram'],
];

export function GeneratePanel({
  workspaceId,
  chapters,
  files,
  onOpenItem,
  onGeneratingChange,
}: {
  workspaceId: string;
  chapters: Chapter[];
  files: SourceFile[];
  onOpenItem?: (item: OpenItem) => void;
  onGeneratingChange?: (mode: GenerateMode | null) => void;
}) {
  const gen = useGenerate(workspaceId);
  const [mode, setMode] = useState<GenerateMode | null>(null);
  const [result, setResult] = useState<GenerateResultData | null>(null);

  async function handleGenerate(opts: GenerateOptions) {
    onGeneratingChange?.(opts.kind);
    setMode(null);
    try {
      const r = (await gen.mutateAsync(opts)) as GenerateResultData;
      setResult(r);
      // Reveal the freshly-generated artifact in the center pane.
      const materialId =
        r.kind === 'quiz'
          ? r.quiz?.id
          : r.kind === 'flashcards'
            ? r.deck?.id
            : r.material?.id;
      if (materialId) onOpenItem?.({ id: materialId, kind: 'material' });
    } catch (error) {
      userToast({
        description:
          error instanceof Error ? error.message : 'Something went wrong.',
        title: 'Could not generate material',
        variant: 'error',
      });
    } finally {
      onGeneratingChange?.(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4">
      <h3 className="t-subtitle">{m.generate_title()}</h3>
      <div className="flex flex-wrap gap-3">
        {TILES.map(([k, icon, label]) => (
          <Button asChild key={k} size="lg" variant="outline">
            <button
              className="flex aspect-video w-30 flex-col items-center justify-center gap-2 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:bg-initial hover:shadow-card"
              disabled={gen.isPending}
              key={k}
              onClick={() => {
                setResult(null);
                setMode(k);
              }}
              type="button"
            >
              <Icon name={icon} size={22} />
              <span className="font-semibold text-xs tracking-wide">
                {label}
              </span>
            </button>
          </Button>
        ))}
      </div>

      {result && <GenerateResult onOpenItem={onOpenItem} result={result} />}

      {mode && (
        <GenerateFormDialog
          chapters={chapters}
          files={files}
          key={mode}
          mode={mode}
          onGenerate={handleGenerate}
          open
          pending={gen.isPending}
          setOpen={(o) => {
            if (!o) setMode(null);
          }}
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
      label = `Quiz "${result.quiz.name}" ready — ${result.quiz.questions.length} questions.`;
      open = { id: result.quiz.id, kind: 'material' };
    }
  } else if (result.kind === 'flashcards') {
    label = `Deck ready — ${result.cards?.length ?? 0} cards.`;
    if (result.deck) open = { id: result.deck.id, kind: 'material' };
  } else if (result.material) {
    label = `${result.kind === 'mindmap' ? 'Mindmap' : 'Diagram'} "${result.material.title}" ready.`;
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
          Open in view
        </Button>
      )}
    </div>
  );
}
