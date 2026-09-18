import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useFile, useFlashcardSet, useMaterial, useQuiz } from '@/api/hooks';
import type {
  Chapter,
  Material,
  MaterialKind,
  SourceFile,
  UserColor,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
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
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { MATERIALMODE_ICON, MATERIALMODE_LABEL } from './materialIconMappings';
import { type MaterialMode, materialModePolicy } from './modePolicy';
import type { OpenItem } from './openItem';

function useHeader(item: OpenItem): {
  file?: SourceFile;
  icon: FileIconName;
  title?: string;
  material?: Material;
  materialKind?: MaterialKind;
  showImageZoom: boolean;
  modeOptions?: { value: MaterialMode; label: string }[];
  defaultMode?: MaterialMode;
} {
  const { data: fileData } = useFile(item.kind === 'file' ? item.id : null, {
    errorBoundary: false,
  });
  const { data: materialData } = useMaterial(
    item.kind === 'material' ? item.id : null,
    { errorBoundary: false }
  );
  if (item.kind === 'file') {
    return {
      file: fileData,
      icon: fileData ? fileIconName(fileData) : '_file',
      showImageZoom: !!fileData && isImageFile(fileData),
      title: fileData?.name,
    };
  }
  const mt = materialData;
  if (!mt) return { icon: '_file', showImageZoom: false, title: undefined };
  return {
    defaultMode: materialModePolicy(mt.kind, mt.capabilities).defaultMode,
    icon: materialIconName(mt.kind),
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

function FlashcardSetPreviewActions({
  flashcardSetId,
}: {
  flashcardSetId: string;
}) {
  const { data: flashcardSetData, isLoading: flashcardSetIsLoading } =
    useFlashcardSet(flashcardSetId, {
      errorBoundary: false,
    });
  const navigate = useNavigate();
  const summary = flashcardSetData
    ? `${flashcardSetData.cardCount} card${flashcardSetData.cardCount === 1 ? '' : 's'} · ${flashcardSetData.knownPct}% known`
    : flashcardSetIsLoading
      ? 'Loading flashcards…'
      : 'Flashcards';

  return (
    <div
      aria-label={m.material_flashcard_actions()}
      className="flex min-w-0 items-center gap-3"
      role="toolbar"
    >
      <span className="t-meta min-w-0 truncate text-fg-muted">{summary}</span>
      <Button
        iconRight="arrowRight"
        onClick={() =>
          navigate({
            params: { flashcardSetId },
            to: '/flashcards/$flashcardSetId',
          })
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
  const { data: quizData, isLoading: quizIsLoading } = useQuiz(quizId, {
    errorBoundary: false,
  });
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
      aria-label={m.material_quiz_actions()}
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
        {m.quiz_start()}
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
  if (kind === 'flashcards')
    return <FlashcardSetPreviewActions flashcardSetId={materialId} />;
  return null;
}

export function Header({
  beforeFileDelete,
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
  leading,
}: {
  beforeFileDelete?: () => boolean;
  /** Workspace chrome drawn before the file: layout toggle and workspace menu. */
  leading?: ReactNode;
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
  // Phones have no room to go fuller than the panel already is.
  const sm = useMediaQuery('(min-width: 640px)');
  return (
    <div className="flex h-14 items-center gap-2 border-divider border-b px-4 py-4">
      {leading}
      {leading && (
        <span className="shrink-0 font-semibold text-line-strong">/</span>
      )}
      <div className="flex min-w-0 items-center gap-1">
        <FileIcon className="size-4.5 shrink-0" name={icon} />
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
            data-testid="editor-save-state"
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
              aria-label={m.material_mode()}
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
              label={m.material_zoom_out()}
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
              label={m.material_zoom_in()}
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
          beforeDelete={file ? beforeFileDelete : undefined}
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
          leadingItems={
            sm
              ? [
                  {
                    icon: isFullscreen ? 'minimize' : 'maximize',
                    label: isFullscreen
                      ? m.material_fullscreen_exit()
                      : m.material_fullscreen(),
                    onClick: onToggleFullscreen,
                  },
                ]
              : []
          }
          menuIconContainerClassName="shrink-0"
          onDeleted={onDeleted}
          readOnly={readOnly}
          renameFieldLabel={m.files_file_name()}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
}
