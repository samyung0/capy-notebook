import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  useDeck,
  useFile,
  useMaterial,
  useQuiz,
  useReviewMaterialSuggestions,
} from '@/api/hooks';
import type { MaterialKind, UserColor } from '@/api/types';
import {
  Button,
  Icon,
  IconButton,
  type IconName,
  ProgressBar,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/ui';
import { FileViewer } from '@/features/files/FileViewer';
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
import { MaterialPreview } from './MaterialPreview';
import {
  isInteractiveMaterialMode,
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from './modePolicy';
import type { OpenItem } from './openItem';

/* Interactive Plate is the heaviest chunk in this route. View mode
 * deliberately never loads it. */
const NoteEditor = lazy(() =>
  import('@/features/notes/NoteEditor').then((m) => ({
    default: m.NoteEditor,
  }))
);

/** The center pane. Dispatches on the currently-open item — a source file or a
 * study material — and renders a consistent header plus the item body. Quiz and
 * flashcards materials get view actions in the header; mindmaps/diagrams render inline.
 * User-authored notes take over the whole pane with the editable Plate editor. */
export function CenterContent({
  item,
  readOnly = false,
  color,
  onSuggestionDirtyChange,
}: {
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onSuggestionDirtyChange?: (dirty: boolean) => void;
}) {
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const [materialMode, setMaterialMode] = useState<MaterialMode | null>(null);
  const [suggestionDirty, setSuggestionDirty] = useState(false);
  const [editorStatus, setEditorStatus] = useState<NoteEditorStatus | null>(
    null
  );
  const [collaborationVersion, setCollaborationVersion] = useState(0);
  const [collaborationActionsHost, setCollaborationActionsHost] =
    useState<HTMLDivElement | null>(null);
  const updateSuggestionDirty = useCallback(
    (dirty: boolean) => {
      setSuggestionDirty(dirty);
      onSuggestionDirtyChange?.(dirty);
    },
    [onSuggestionDirtyChange]
  );

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setMaterialMode(null);
    updateSuggestionDirty(false);
    setEditorStatus(null);
    setCollaborationVersion(0);
  }, [item?.kind, item?.id, updateSuggestionDirty]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    if (
      suggestionDirty &&
      !window.confirm(
        'Discard the unsubmitted suggestion draft and change modes?'
      )
    ) {
      return;
    }
    updateSuggestionDirty(false);
    setEditorStatus(null);
    setMaterialMode(nextMode);
  };

  if (!item) {
    return <EmptyCenter />;
  }
  return (
    <>
      <Header
        collaborationActionsRef={setCollaborationActionsHost}
        editorStatus={editorStatus}
        imageZoom={imageZoom}
        item={item}
        materialMode={materialMode}
        onBulkReviewed={() => setCollaborationVersion((version) => version + 1)}
        onImageZoomChange={setImageZoom}
        onMaterialModeChange={changeMaterialMode}
      />
      <div className="relative min-h-0 flex-1 overflow-auto">
        {item.kind === 'material' && (
          <MaterialBody
            allowExternalAssets={!readOnly}
            collaborationActionsHost={collaborationActionsHost}
            key={`${item.id}:${collaborationVersion}`}
            materialId={item.id}
            mode={materialMode}
            onEditorStatusChange={setEditorStatus}
            onSuggestionDirtyChange={updateSuggestionDirty}
          />
        )}
        {item.kind === 'file' && (
          <FileBody
            color={color}
            fileId={item.id}
            imageZoom={imageZoom}
            onImageZoomChange={setImageZoom}
          />
        )}
      </div>
    </>
  );
}

const MATERIALMODE_ICON: Record<MaterialMode, IconName> = {
  edit: 'write',
  suggestion: 'rubber',
  view: 'eye',
};

const MATERIALMODE_LABEL: Record<MaterialMode, string> = {
  edit: 'Edit',
  suggestion: 'Suggestion',
  view: 'View',
};

function MaterialBody({
  materialId,
  mode,
  allowExternalAssets,
  onSuggestionDirtyChange,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  onSuggestionDirtyChange: (dirty: boolean) => void;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost: HTMLDivElement | null;
}) {
  const { data: material, isLoading, isError } = useMaterial(materialId);
  if (isLoading) {
    return <FileLoading />;
  }
  if (isError || !material) {
    return <FileError />;
  }
  const policy = materialModePolicy(material.kind, material.capabilities);
  const activeMode = resolveMaterialMode(mode, policy);

  return (
    <div className="h-full min-h-0">
      {activeMode === 'view' && (
        <div className="h-full min-h-0 overflow-auto">
          <MaterialPreview
            className="mx-auto max-w-175"
            content={material.content}
          />
        </div>
      )}
      {isInteractiveMaterialMode(activeMode) && (
        <Suspense fallback={<FileLoading />}>
          <NoteEditor
            allowExternalAssets={allowExternalAssets}
            collaborationActionsHost={collaborationActionsHost}
            key={`${materialId}:${activeMode}`}
            materialId={materialId}
            mode={activeMode}
            onEditorStatusChange={onEditorStatusChange}
            onSuggestionDirtyChange={onSuggestionDirtyChange}
          />
        </Suspense>
      )}
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

function BulkSuggestionActions({
  materialId,
  onReviewed,
}: {
  materialId: string;
  onReviewed: () => void;
}) {
  const { data: material } = useMaterial(materialId);
  const review = useReviewMaterialSuggestions(materialId);
  if (!material?.capabilities.canEdit || !material.hasPendingSuggestions)
    return null;

  const run = (decision: 'accept' | 'reject') => {
    if (
      !window.confirm(
        `${decision === 'accept' ? 'Accept' : 'Reject'} all pending suggestions in this material?`
      )
    ) {
      return;
    }
    review.mutate(
      {
        decision,
        expectedRevision: material.revision ?? 1,
      },
      { onSuccess: onReviewed }
    );
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        disabled={review.isPending}
        onClick={() => run('accept')}
        size="sm"
        variant="ghost-hover"
      >
        Accept all
      </Button>
      <Button
        disabled={review.isPending}
        onClick={() => run('reject')}
        size="sm"
        variant="ghost-hover"
      >
        Reject all
      </Button>
    </div>
  );
}

function EmptyCenter() {
  return (
    <>
      <div className="flex items-center gap-3 border-divider border-b px-5 py-4">
        <Icon className="size-5.5" name="files" />
        <h2 className="t-subtitle translate-y-px truncate">--</h2>
      </div>
      <div className="grid flex-1 place-items-center p-6">
        <div className="flex flex-col items-center gap-2">
          <Icon className="size-7" name="files" />
          <p>Select a file or material to view it here.</p>
        </div>
      </div>
    </>
  );
}

function Header({
  item,
  imageZoom,
  onImageZoomChange,
  materialMode,
  onMaterialModeChange,
  editorStatus,
  collaborationActionsRef,
  onBulkReviewed,
}: {
  item: OpenItem;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  materialMode: MaterialMode | null;
  onMaterialModeChange: (mode: MaterialMode) => void;
  editorStatus: NoteEditorStatus | null;
  collaborationActionsRef: (node: HTMLDivElement | null) => void;
  onBulkReviewed: () => void;
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
      <Icon className="size-5.5" name={icon} />
      <h2 className="t-subtitle min-w-0 flex-1 translate-y-px truncate">
        {title ?? '--'}
      </h2>
      <div className="ml-auto flex items-center gap-2">
        {item.kind === 'material' && (
          <BulkSuggestionActions
            materialId={item.id}
            onReviewed={onBulkReviewed}
          />
        )}
        {item.kind === 'material' && activeMode === 'view' && materialKind && (
          <MaterialViewActions kind={materialKind} materialId={item.id} />
        )}
        {statusLabel && (
          <span
            className={cn(
              'px-1 text-fg-muted text-xs',
              editorStatus?.mode === 'edit' &&
                editorStatus.saveState === 'error' &&
                'text-solid-error'
            )}
            role="status"
          >
            {statusLabel}
          </span>
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

function materialIcon(kind: MaterialKind): IconName {
  switch (kind) {
    case 'diagram':
      return 'grid';
    case 'quiz':
      return 'quiz';
    case 'flashcards':
      return 'flashcards';
    case 'note':
      return 'write';
    default:
      return 'workspaces';
  }
}

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

export function FileLoading() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <Spinner />
      <p>Loading preview...</p>
    </div>
  );
}

export function FileError() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 font-semibold text-solid-error">
      <p className="mt-3">Unable to load file. Please refresh and try again.</p>
    </div>
  );
}

export function FileEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 font-semibold text-solid-error">
      <p className="mt-3">
        The file is empty or corrupted. Please reupload and try again.
      </p>
    </div>
  );
}

function FileBody({
  fileId,
  color,
  imageZoom,
  onImageZoomChange,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
}) {
  const { data: file, isLoading, isError } = useFile(fileId);
  if (isLoading) return <FileLoading />;
  if (!isLoading && isError) return <FileError />;
  if (file?.status === 'processing') {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-64 -translate-y-1/2 flex-col items-center gap-3">
          <Icon className="size-7" name="sparkles" />
          <p>Processing {file.name}…</p>
          <ProgressBar
            className="w-full"
            showLabel
            tone={color}
            value={file.ingestPct ?? 0}
          />
        </div>
      </div>
    );
  }
  if (file?.status === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 font-semibold text-solid-error">
        <p className="mt-3">Unable to process file {file.name}.</p>
      </div>
    );
  }
  return (
    <FileViewer
      file={file ?? null}
      imageZoom={imageZoom}
      onImageZoomChange={onImageZoomChange}
    />
  );
}
