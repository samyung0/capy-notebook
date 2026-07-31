import { useNavigate } from '@tanstack/react-router';
import { useDeck, useFile, useMaterial, useQuiz } from '@/api/hooks';
import type { MaterialKind } from '@/api/types';
import {
  Button,
  Icon,
  IconButton,
  type IconName,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import {
  clampImageZoom,
  IMAGE_MAX_ZOOM,
  IMAGE_MIN_ZOOM,
  IMAGE_ZOOM_STEP,
  isImageFile,
} from '@/features/files/fileUtils';
import {
  type NoteEditorStatus,
  noteEditorStatusLabel,
} from '@/features/notes/editorMode';
import { cn } from '@/lib/cn';
import {
  MATERIALMODE_ICON,
  MATERIALMODE_LABEL,
  materialIcon,
} from './materialIconMappings';
import {
  isInteractiveMaterialMode,
  type MaterialMode,
  materialModePolicy,
} from './modePolicy';
import type { OpenItem } from './openItem';

function useHeader(item: OpenItem): {
  icon: IconName;
  title?: string;
  materialKind?: MaterialKind;
  showImageZoom: boolean;
  modeOptions?: { value: MaterialMode; label: string }[];
  defaultMode?: MaterialMode;
} {
  const file = useFile(item.kind === 'file' ? item.id : null);
  const material = useMaterial(item.kind === 'material' ? item.id : null);
  if (item.kind === 'file') {
    return {
      icon: 'files',
      showImageZoom: !!file.data && isImageFile(file.data),
      title: file.data?.name,
    };
  }
  const mt = material.data;
  if (!mt)
    return { icon: 'workspaces', showImageZoom: false, title: undefined };
  return {
    defaultMode: materialModePolicy(mt.kind, mt.capabilities).defaultMode,
    icon: materialIcon(mt.kind),
    materialKind: mt.kind,
    modeOptions: materialModePolicy(mt.kind, mt.capabilities).modes.map(
      (value) => ({
        label: MATERIALMODE_LABEL[value],
        value,
      })
    ),
    showImageZoom: false,
    title: mt.title,
  };
}

function DeckPreviewActions({ deckId }: { deckId: string }) {
  const deck = useDeck(deckId);
  const navigate = useNavigate();
  const summary = deck.data
    ? `${deck.data.cardCount} card${deck.data.cardCount === 1 ? '' : 's'} · ${deck.data.knownPct}% known`
    : deck.isLoading
      ? 'Loading deck details…'
      : 'Flashcards';

  return (
    <div
      aria-label="Flashcard actions"
      className="flex min-w-0 items-center gap-3"
      role="toolbar"
    >
      <span className="t-meta min-w-0 truncate text-fg-muted">{summary}</span>
      <Button
        iconRight="arrowRight"
        onClick={() =>
          navigate({ params: { deckId }, to: '/flashcards/$deckId' })
        }
        size="sm"
        variant="ghost-hover"
      >
        Study
      </Button>
    </div>
  );
}

function QuizPreviewActions({ quizId }: { quizId: string }) {
  const quiz = useQuiz(quizId);
  const navigate = useNavigate();
  const summary = quiz.data
    ? `${quiz.data.questions.length} question${quiz.data.questions.length === 1 ? '' : 's'}${
        quiz.data.timeLimitMin == null
          ? ''
          : ` · Time limit: ${quiz.data.timeLimitMin} min`
      }`
    : quiz.isLoading
      ? 'Loading quiz details…'
      : 'Quiz';

  return (
    <div
      aria-label="Quiz actions"
      className="flex min-w-0 items-center gap-3"
      role="toolbar"
    >
      <span className="t-meta min-w-0 truncate text-fg-muted">{summary}</span>
      <Button
        className="font-medium text-sm"
        iconRight="arrowRight"
        onClick={() =>
          navigate({ params: { quizId }, to: '/quizzes/$quizId/attempt' })
        }
        size="sm"
        variant="ghost-hover"
      >
        Start quiz
      </Button>
    </div>
  );
}

function MaterialViewActions({
  materialId,
  kind,
}: {
  materialId: string;
  kind: MaterialKind;
}) {
  if (kind === 'quiz') return <QuizPreviewActions quizId={materialId} />;
  if (kind === 'flashcards') return <DeckPreviewActions deckId={materialId} />;
  return null;
}

export function Header({
  item,
  imageZoom,
  onImageZoomChange,
  materialMode,
  onMaterialModeChange,
  editorStatus,
  collaborationActionsRef,
}: {
  item: OpenItem;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  materialMode: MaterialMode | null;
  onMaterialModeChange: (mode: MaterialMode) => void;
  editorStatus: NoteEditorStatus | null;
  collaborationActionsRef: (node: HTMLDivElement | null) => void;
}) {
  // TODO: magic wand for summary/AI related stuff, then some tool box? same action menu
  const { icon, title, materialKind, showImageZoom, modeOptions, defaultMode } =
    useHeader(item);
  const activeMode =
    materialMode && modeOptions?.some((option) => option.value === materialMode)
      ? materialMode
      : defaultMode;
  const statusLabel = noteEditorStatusLabel(editorStatus);
  return (
    <div className="flex h-14 items-center gap-3 border-divider border-b px-5 py-4">
      <div className="flex items-center gap-1">
        <Icon name={icon} />
        <h2 className="t-subtitle ml-1 min-w-0 flex-1 translate-y-px truncate">
          {title ?? '--'}
        </h2>
        {statusLabel && (
          <span
            className={cn(
              '-translate-y-px self-end px-1 text-fg-muted text-xs leading-(--subtitle-line-height)',
              editorStatus?.mode === 'edit' &&
                editorStatus.saveState === 'error' &&
                'text-solid-error'
            )}
            role="status"
          >
            {statusLabel}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {item.kind === 'material' && activeMode === 'view' && materialKind && (
          <MaterialViewActions kind={materialKind} materialId={item.id} />
        )}
        {activeMode && isInteractiveMaterialMode(activeMode) && (
          <div
            aria-label="Material collaboration"
            className="flex items-center gap-1"
            ref={collaborationActionsRef}
            role="toolbar"
          />
        )}
        {modeOptions && modeOptions.length > 1 && activeMode && (
          <Select
            onValueChange={(value) =>
              onMaterialModeChange(value as MaterialMode)
            }
            value={activeMode}
          >
            <SelectTrigger variant="ghost-hover">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {modeOptions.map((o) => (
                  <SelectItem
                    className="text-sm"
                    key={o.value}
                    size="sm"
                    value={o.value}
                  >
                    <div className="flex items-center gap-2">
                      <Icon
                        className="size-3.75 -translate-y-px"
                        name={MATERIALMODE_ICON[o.value]}
                      />
                      <span>{o.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showImageZoom && (
          <div className="flex items-center gap-0.5">
            <IconButton
              className="p-1.5"
              disabled={imageZoom <= IMAGE_MIN_ZOOM}
              icon="zoomOut"
              label="Zoom out"
              onClick={() =>
                onImageZoomChange(clampImageZoom(imageZoom - IMAGE_ZOOM_STEP))
              }
              size="sm"
              strokeWidth={1.5}
              variant="ghost-hover"
            />
            <IconButton
              className="p-1.5"
              disabled={imageZoom >= IMAGE_MAX_ZOOM}
              icon="zoomIn"
              label="Zoom in"
              onClick={() =>
                onImageZoomChange(clampImageZoom(imageZoom + IMAGE_ZOOM_STEP))
              }
              size="sm"
              strokeWidth={1.5}
              variant="ghost-hover"
            />
          </div>
        )}
      </div>
    </div>
  );
}
