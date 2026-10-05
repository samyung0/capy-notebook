import { useState } from 'react';
import { isApiError } from '@/api/client';
import {
  useChapters,
  useFiles,
  useGenerate,
  useMaterials,
  useWorkspace,
} from '@/api/hooks';
import type { GenerateOptions } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { userToast } from '@/components/ui/userToast';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { deferStorageRefusal, describeError } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import {
  GenerateForm,
  type GenerateMode,
  generateModeLabel,
} from './GenerateForm';

const KINDS: GenerateMode[] = ['quiz', 'flashcards', 'mindmap', 'diagram'];

type Generated =
  | { kind: 'quiz'; quiz?: { id: string } }
  | { kind: 'flashcards' | 'mindmap' | 'diagram'; material?: { id: string } };

/** AI generate in the Add file dialog: pick a kind from the tiles, set its
 * options, Generate. The dialog closes at once, like Upload and Import; the
 * file tree shows the material being made and it opens when ready. */
export function GenerateFilePanel({
  workspaceId,
  onClose,
  onOpenItem,
  onGeneratingChange,
}: {
  workspaceId: string;
  onClose: () => void;
  onOpenItem?: (item: OpenItem) => void;
  onGeneratingChange?: (mode: GenerateMode | null) => void;
}) {
  const [mode, setMode] = useState<GenerateMode>('quiz');
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { isPending, mutateAsync: generate } = useGenerate(workspaceId, {
    errorToast: false,
  });

  async function run(opts: GenerateOptions) {
    onClose();
    onGeneratingChange?.(opts.kind);
    try {
      const made = (await generate(opts)) as Generated;
      const id = made.kind === 'quiz' ? made.quiz?.id : made.material?.id;
      if (id) onOpenItem?.({ id, kind: 'material' });
    } catch (error) {
      if (isApiError(error) && error.code === 'pending_sources_too_large')
        userToast({
          id: 'generate-failed',
          title: m.source_pending_context(),
          variant: 'error',
        });
      // A frozen or storage refusal shows as the workspace status instead.
      else if (!deferStorageRefusal(error))
        userToast({
          description: describeError(error).description,
          id: 'generate-failed',
          title: m.generate_failed(),
          variant: 'error',
        });
    } finally {
      onGeneratingChange?.(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="grid shrink-0 grid-cols-4 gap-2">
        {KINDS.map((k) => (
          <button
            aria-pressed={mode === k}
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-card border px-2 py-3 font-medium text-sm transition-colors',
              mode === k
                ? 'border-solid-accent-1 bg-tint-accent-1/60'
                : 'border-line hover:bg-surface-hover-bg'
            )}
            key={k}
            onClick={() => setMode(k)}
            type="button"
          >
            <FileIcon className="size-5.5" name={materialIconName(k)} />
            {generateModeLabel(k)}
          </button>
        ))}
      </div>
      <GenerateForm
        chapters={chapters ?? []}
        existingTitles={(materials ?? []).map((mt) => mt.title)}
        files={files ?? []}
        key={mode}
        mode={mode}
        onCancel={onClose}
        onGenerate={run}
        pending={isPending}
        workspaceName={workspace?.name ?? ''}
      />
    </div>
  );
}
