import { useNavigate } from '@tanstack/react-router';
import { useDeck, useFile, useMaterial, useQuiz } from '@/api/hooks';
import type {
  Chapter,
  Material,
  MaterialKind,
  SourceFile,
  UserColor,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
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
import {
  ContentActions,
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/ContentActions';
import { cn } from '@/lib/cn';
import {
  MATERIALMODE_ICON,
  MATERIALMODE_LABEL,
  materialIcon,
} from './materialIconMappings';
import { type MaterialMode, materialModePolicy } from './modePolicy';
import type { OpenItem } from './openItem';

function useHeader(item: OpenItem): {
  file?: SourceFile;
  icon: IconName;
  title?: string;
  material?: Material;
  materialKind?: MaterialKind;
  showImageZoom: boolean;
  modeOptions?: { value: MaterialMode; label: string }[];
  defaultMode?: MaterialMode;
} {
  const { data: fileData } = useFile(item.kind === 'file' ? item.id : null);
  const { data: materialData } = useMaterial(
    item.kind === 'material' ? item.id : null
  );
  if (item.kind === 'file') {
    return {
      file: fileData,
      icon: 'files',
      showImageZoom: !!fileData && isImageFile(fileData),
      title: fileData?.name,
    };
  }
  const mt = materialData;
  if (!mt)
    return { icon: 'workspaces', showImageZoom: false, title: undefined };
  return {
    defaultMode: materialModePolicy(mt.kind, mt.capabilities).defaultMode,
    icon: materialIcon(mt.kind),
    material: mt,
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
  const { data: deckData, isLoading: deckIsLoading } = useDeck(deckId);
  const navigate = useNavigate();
  const summary = deckData
    ? `${deckData.cardCount} card${deckData.cardCount === 1 ? '' : 's'} · ${deckData.knownPct}% known`
    : deckIsLoading
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
  const { data: quizData, isLoading: quizIsLoading } = useQuiz(quizId);
  const navigate = useNavigate();
  const summary = quizData
    ? `${quizData.questions.length} question${quizData.questions.length === 1 ? '' : 's'}${
        quizData.timeLimitMin == null
          ? ''
          : ` · Time limit: ${quizData.timeLimitMin} min`
      }`
    : quizIsLoading
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
  chapters,
  color,
  item,
  imageZoom,
  onImageZoomChange,
  materialMode,
  onMaterialModeChange,
  isFullscreen,
  onDeleted,
  onToggleFullscreen,
  editorStatus,
  readOnly,
  workspaceId,
}: {
  chapters: Chapter[];
  color?: UserColor;
  item: OpenItem;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  materialMode: MaterialMode | null;
  onMaterialModeChange: (mode: MaterialMode) => void;
  isFullscreen: boolean;
  onDeleted: () => void;
  onToggleFullscreen: () => void;
  editorStatus: NoteEditorStatus | null;
  readOnly: boolean;
  workspaceId: string;
}) {
  // TODO: magic wand for summary/AI related stuff, then some tool box? same action menu
  const {
    file,
    icon,
    material,
    title,
    materialKind,
    showImageZoom,
    modeOptions,
    defaultMode,
  } = useHeader(item);
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
      <div className="ml-auto flex items-center">
        {item.kind === 'material' && activeMode === 'view' && materialKind && (
          <MaterialViewActions kind={materialKind} materialId={item.id} />
        )}
        {modeOptions && modeOptions.length > 1 && activeMode && (
          <Select
            onValueChange={(value) =>
              onMaterialModeChange(value as MaterialMode)
            }
            value={activeMode}
          >
            <SelectTrigger
              aria-label="Material mode"
              className="px-1.5 py-2"
              variant="ghost-hover"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {modeOptions.map((o) => (
                  <SelectItem
                    className="text-sm"
                    iconAndValue={{
                      icon: MATERIALMODE_ICON[o.value],
                      label: o.label,
                    }}
                    key={o.value}
                    size="sm"
                    value={o.value}
                  />
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {showImageZoom && (
          <>
            <IconButton
              // className="p-1.5"
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
              // className="p-1.5"
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
          </>
        )}
        <ContentActions
          chapters={chapters}
          color={color}
          content={
            file
              ? toFileActionTarget(file)
              : material
                ? toMaterialActionTarget(material)
                : undefined
          }
          display="menu"
          key={`${item.kind}:${item.id}`}
          leadingItems={[
            {
              icon: isFullscreen ? 'minimize' : 'maximize',
              label: isFullscreen ? 'Exit full screen' : 'Full screen',
              onClick: onToggleFullscreen,
            },
          ]}
          menuIconContainerClassName="shrink-0"
          onDeleted={onDeleted}
          readOnly={readOnly}
          renameFieldLabel="File Name"
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
}
