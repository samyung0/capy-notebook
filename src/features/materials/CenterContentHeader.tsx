import { useNavigate } from '@tanstack/react-router';
import { Toggle } from 'radix-ui';
import type { ReactNode } from 'react';
import {
  useFile,
  useFlashcardSet,
  useMaterial,
  useMaterials,
  useQuiz,
  useWorkspace,
} from '@/api/hooks';
import type {
  AccessCapabilities,
  Chapter,
  Material,
  MaterialKind,
  MaterialRef,
  SourceFile,
  UserColor,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
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
import { MATERIALMODE_ICON } from './materialIconMappings';
import { type MaterialMode, materialModePolicy } from './modePolicy';
import type { OpenItem } from './openItem';

function useHeader(
  item: OpenItem,
  workspaceId: string,
  standalone: boolean
): {
  file?: SourceFile;
  icon: FileIconName;
  title?: string;
  material?: Material | MaterialRef;
  materialCapabilities?: AccessCapabilities;
  materialKind?: MaterialKind;
  showImageZoom: boolean;
  modes?: readonly MaterialMode[];
  defaultMode?: MaterialMode;
} {
  const { data: fileData } = useFile(item.kind === 'file' ? item.id : null, {
    errorBoundary: false,
  });
  // Inside a workspace the list entry and the workspace's capabilities cover
  // everything the header shows. Reading the material itself here would pull
  // the whole document past the heavy-document gate, so the body is fetched
  // only when the list cannot answer: the standalone page, or a material the
  // list does not carry, which the gate cannot weigh either.
  const inWorkspace =
    item.kind === 'material' && !standalone && workspaceId !== '';
  const { data: list, isPending: listPending } = useMaterials(
    inWorkspace ? workspaceId : '',
    { errorBoundary: false }
  );
  const { data: workspace } = useWorkspace(inWorkspace ? workspaceId : '', {
    errorBoundary: false,
  });
  const listed = inWorkspace
    ? list?.find((entry) => entry.id === item.id)
    : undefined;
  const readBody =
    item.kind === 'material' && (!inWorkspace || (!listPending && !listed));
  const { data: materialData } = useMaterial(readBody ? item.id : null, {
    errorBoundary: false,
  });
  if (item.kind === 'file') {
    return {
      file: fileData,
      icon: fileData ? fileIconName(fileData) : '_file',
      showImageZoom: !!fileData && isImageFile(fileData),
      title: fileData?.name,
    };
  }
  const mt = listed ?? materialData;
  const capabilities = listed
    ? workspace?.capabilities
    : materialData?.capabilities;
  if (!mt || !capabilities) {
    return { icon: '_file', showImageZoom: false, title: mt?.title };
  }
  const kind = 'type' in mt ? mt.type : mt.kind;
  const policy = materialModePolicy(capabilities);
  return {
    defaultMode: policy.defaultMode,
    icon: materialIconName(kind),
    material: mt,
    materialCapabilities: capabilities,
    materialKind: kind,
    modes: policy.modes,
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
  standalone = false,
  fileControls,
}: {
  standalone?: boolean;
  fileControls?: ReactNode;
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
  const {
    file,
    icon,
    material,
    materialCapabilities,
    title,
    materialKind,
    showImageZoom,
    modes,
    defaultMode,
  } = useHeader(item, workspaceId, standalone);
  const activeMode =
    materialMode && modes?.includes(materialMode) ? materialMode : defaultMode;
  const statusLabel = noteEditorStatusLabel(editorStatus);
  // Phones have no room to go fuller than the panel already is.
  const sm = useMediaQuery('(min-width: 640px)');
  return (
    <div
      className="flex h-14 items-center gap-2 border-divider border-b py-4 pr-2 pl-4"
      data-testid="content-header"
    >
      {leading}
      <div className="-ml-2 flex min-w-0 items-center gap-2 sm:-ml-0.5 lg:ml-2">
        <FileIcon className="size-5 shrink-0 -translate-y-px" name={icon} />
        <h2
          className={cn(
            'min-w-0 flex-1 truncate',
            leading ? 't-body font-semibold' : 't-subtitle'
          )}
        >
          {title ?? '--'}
        </h2>
        {statusLabel && (
          <span
            className={cn(
              't-meta px-1 text-fg-muted leading-(--subtitle-line-height)',
              editorStatus?.saveState === 'error' && 'text-solid-error'
            )}
            data-testid="editor-save-state"
            role="status"
          >
            {statusLabel}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-0">
        {item.kind === 'file' && fileControls}
        {item.kind === 'material' && activeMode === 'view' && materialKind && (
          <MaterialViewActions kind={materialKind} materialId={item.id} />
        )}
        {modes && modes.length > 1 && activeMode && (
          <Toggle.Root
            asChild
            onPressedChange={(pressed) =>
              onMaterialModeChange(pressed ? 'edit' : 'view')
            }
            pressed={activeMode === 'edit'}
          >
            <ToolbarButton
              aria-label={m.material_mode()}
              label={
                activeMode === 'edit'
                  ? m.material_mode_edit()
                  : m.material_mode_view()
              }
            >
              <Icon name={MATERIALMODE_ICON[activeMode]} />
            </ToolbarButton>
          </Toggle.Root>
        )}
        {showImageZoom && (
          <>
            <ToolbarButton
              disabled={imageZoom <= IMAGE_MIN_ZOOM}
              label={m.material_zoom_out()}
              onClick={() =>
                onImageZoomChange(clampImageZoom(imageZoom - IMAGE_ZOOM_STEP))
              }
            >
              <Icon name="zoomOut" />
            </ToolbarButton>
            <ToolbarButton
              disabled={imageZoom >= IMAGE_MAX_ZOOM}
              label={m.material_zoom_in()}
              onClick={() =>
                onImageZoomChange(clampImageZoom(imageZoom + IMAGE_ZOOM_STEP))
              }
            >
              <Icon name="zoomIn" />
            </ToolbarButton>
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
          menuTrigger={
            <ToolbarButton label={m.a11y_open_menu()}>
              <Icon name="moreVertical" />
            </ToolbarButton>
          }
          onDeleted={onDeleted}
          readOnly={
            readOnly ||
            (materialCapabilities ? !materialCapabilities.canEdit : false)
          }
          renameFieldLabel={m.files_file_name()}
          showMove={!standalone}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
}
