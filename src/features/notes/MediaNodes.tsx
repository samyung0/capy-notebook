import {
  Caption,
  CaptionPlugin,
  CaptionTextarea,
} from '@platejs/caption/react';
import {
  PlaceholderPlugin,
  PlaceholderProvider,
  updateUploadHistory,
} from '@platejs/media/react';
import type { TElement, TPlaceholderElement } from 'platejs';
import { KEYS } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useEditorPlugin,
  useEditorRef,
  useReadOnly,
  withHOC,
} from 'platejs/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFilePicker } from 'use-file-picker';
import { isStorageQuotaError } from '@/api/client';
import { uploadEditorAsset } from '@/api/editorAssets';
import type { IconName } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Separator } from '@/components/ui/Separator';
import { userToast } from '@/components/ui/userToast';
import {
  type MediaAssetNode,
  MediaAssetView,
  openEditorAsset,
} from '@/features/materials/MediaAssetView';
import { MediaFrame } from '@/features/materials/MediaFrame';
import {
  YouTubeEmbed,
  type YouTubeNode,
  youtubeWatchUrl,
} from '@/features/materials/YouTubeEmbed';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { deferStorageRefusal, errorCopy } from '@/lib/errors';
import { useEditorRuntime, useOptionalEditorRuntime } from './EditorRuntime';
import {
  acceptsPurpose,
  editorAssetPurpose,
  isVideoFile,
  MEDIA_ACCEPT,
  mediaNodeFromAsset,
  type plateMediaType,
} from './media';
import { MEDIA_CAPTION_CLASS } from './nodeStyles';
import { ToolbarButton } from './toolbar/ToolbarButton';
import { youtubeVideoId } from './youtube';

type MediaType = ReturnType<typeof plateMediaType>;

const PLACEHOLDER_COPY: Record<
  MediaType,
  { label: () => string; icon: IconName }
> = {
  audio: { icon: 'fileAudio', label: () => m.editor_add_audio() },
  file: { icon: 'fileText', label: () => m.editor_add_file() },
  img: { icon: 'image', label: () => m.editor_add_image() },
};

function purposeForMediaType(type: string) {
  if (type === KEYS.img) return 'image' as const;
  if (type === KEYS.audio) return 'audio' as const;
  return 'file' as const;
}

export const MediaPlaceholderElement = withHOC(
  PlaceholderProvider,
  function MediaPlaceholderElement(
    props: PlateElementProps<TPlaceholderElement>
  ) {
    const { editor, element } = props;
    const { materialId, allowExternalAssets } = useEditorRuntime();
    const canCreateAssets = allowExternalAssets;
    const { api } = useEditorPlugin(PlaceholderPlugin);
    const [progress, setProgress] = useState(0);
    const [uploading, setUploading] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const mediaType = (element.mediaType || KEYS.file) as MediaType;
    const purpose = purposeForMediaType(mediaType);
    const content = PLACEHOLDER_COPY[mediaType] ?? PLACEHOLDER_COPY.file;

    const replaceCurrentPlaceholder = useCallback(
      async (file: File) => {
        if (!canCreateAssets) return;
        if (isVideoFile(file)) {
          setError(m.editor_video_disabled());
          return;
        }
        if (!acceptsPurpose(file, purpose)) {
          setError(
            m.editor_choose_purpose({
              purpose:
                purpose === 'image'
                  ? m.editor_image()
                  : purpose === 'audio'
                    ? m.editor_audio()
                    : m.editor_file(),
            })
          );
          return;
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setUploading(file);
        setProgress(0);
        setError(null);
        api.placeholder.addUploadingFile(element.id as string, file);
        try {
          const asset = await uploadEditorAsset(
            materialId,
            file,
            editorAssetPurpose(file),
            {
              onProgress: setProgress,
              signal: controller.signal,
            }
          );
          const path = editor.api.findPath(element);
          if (!path) return;
          const node = {
            ...mediaNodeFromAsset(asset),
            placeholderId: element.id as string,
          };
          editor.tf.withoutSaving(() => {
            editor.tf.removeNodes({ at: path });
            editor.tf.insertNodes(node, { at: path });
            updateUploadHistory(editor, node);
          });
          api.placeholder.removeUploadingFile(element.id as string);
        } catch (cause) {
          if (!controller.signal.aborted && !deferStorageRefusal(cause)) {
            setError(
              isStorageQuotaError(cause)
                ? m.editor_storage_quota()
                : errorCopy(cause, m.editor_upload_failed())
            );
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          setUploading(null);
        }
      },
      [api.placeholder, canCreateAssets, editor, element, materialId, purpose]
    );

    const { openFilePicker } = useFilePicker({
      accept: [MEDIA_ACCEPT[purpose]],
      multiple: true,
      onFilesSelected: ({ plainFiles }) => {
        if (!canCreateAssets) return;
        const [first, ...rest] = plainFiles;
        if (first) void replaceCurrentPlaceholder(first);
        if (rest.length)
          editor.getTransforms(PlaceholderPlugin).insert.media(rest);
      },
    });

    useEffect(() => {
      if (!canCreateAssets) return;
      const dropped = api.placeholder.getUploadingFile(element.id as string);
      if (dropped) void replaceCurrentPlaceholder(dropped);
      return () => abortRef.current?.abort();
    }, [
      api.placeholder,
      canCreateAssets,
      element.id,
      replaceCurrentPlaceholder,
    ]);

    return (
      <PlateElement {...props} className="my-2">
        <div
          className={cn(
            'flex min-h-18 items-center gap-3 rounded-card border border-line border-dashed bg-surface-hover-bg px-4 py-3',
            canCreateAssets &&
              !uploading &&
              'cursor-pointer hover:border-line-strong'
          )}
          contentEditable={false}
          onClick={() => canCreateAssets && !uploading && openFilePicker()}
          onKeyDown={(event) => {
            if (
              canCreateAssets &&
              !uploading &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              openFilePicker();
            }
          }}
          role={canCreateAssets ? 'button' : undefined}
          tabIndex={canCreateAssets ? 0 : undefined}
        >
          {uploading ? (
            <EditorIcon
              className="size-5 animate-spin text-action-accent"
              name="loader"
            />
          ) : (
            <EditorIcon className="size-5 text-fg-muted" name={content.icon} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-fg text-sm">
              {uploading?.name ?? content.label()}
            </p>
            <p
              className={cn(
                'text-fg-muted text-xs',
                error && 'text-solid-error'
              )}
            >
              {error ??
                (uploading
                  ? m.editor_percent_uploaded({
                      percent: String(progress),
                    })
                  : canCreateAssets
                    ? m.editor_choose_drop()
                    : m.editor_uploads_unavailable())}
            </p>
            {uploading && (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-divider">
                <div
                  className="h-full bg-action-accent transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
          {uploading ? (
            <button
              aria-label={m.editor_cancel_upload()}
              className="rounded-button p-1 text-fg-muted hover:bg-surface"
              onClick={(event) => {
                event.stopPropagation();
                abortRef.current?.abort();
              }}
              type="button"
            >
              <EditorIcon className="size-4" name="x" />
            </button>
          ) : canCreateAssets ? (
            <EditorIcon className="size-4 text-fg-muted" name="upload" />
          ) : null}
        </div>
        {props.children}
      </PlateElement>
    );
  }
);

export function MediaAssetElement(props: PlateElementProps) {
  const element = props.element as unknown as MediaAssetNode;
  const readOnly = useReadOnly();
  // An editing note shows only its own assets (MediaAssetView).
  const runtime = useOptionalEditorRuntime();
  const ownerId = readOnly ? undefined : runtime?.materialId;
  if (element.type !== KEYS.img) {
    return (
      <PlateElement {...props} className="my-3">
        <MediaAssetView element={element} ownerId={ownerId} />
        {props.children}
      </PlateElement>
    );
  }
  return (
    <PlateElement {...props} className="my-3">
      <MediaAssetView
        caption={
          <Caption
            className={MEDIA_CAPTION_CLASS}
            style={{ width: element.width }}
          >
            <CaptionTextarea
              className="w-full resize-none overflow-hidden bg-transparent text-center outline-none placeholder:text-fg-placeholder"
              onBlur={(event) => {
                // An empty caption the user opened and left goes away again.
                if (!event.currentTarget.value)
                  props.editor.setOption(CaptionPlugin, 'visibleId', null);
              }}
              placeholder={m.editor_caption_placeholder()}
            />
          </Caption>
        }
        element={element}
        onWidthChange={
          readOnly
            ? undefined
            : (width) => props.editor.tf.setNodes({ width }, { at: props.path })
        }
        ownerId={ownerId}
        toolbar={<ImageToolbar node={props.element} readOnly={readOnly} />}
      />
      {props.children}
    </PlateElement>
  );
}

function ImageToolbar({
  node,
  readOnly,
}: {
  node: TElement;
  readOnly: boolean;
}) {
  const editor = useEditorRef();
  const element = node as unknown as MediaAssetNode;
  const { materialId, allowExternalAssets } = useEditorRuntime();
  const [replacing, setReplacing] = useState(false);

  const replace = async (file: File) => {
    if (!acceptsPurpose(file, 'image')) {
      userToast({
        title: m.editor_choose_purpose({ purpose: m.editor_image() }),
        variant: 'error',
      });
      return;
    }
    setReplacing(true);
    try {
      const asset = await uploadEditorAsset(materialId, file, 'image');
      const { assetId, contentType, name, sizeBytes } =
        mediaNodeFromAsset(asset);
      // Keep the node id, width and caption; only the picture changes. The
      // block may have been deleted while the upload ran.
      const at = editor.api.findPath(node);
      if (at)
        editor.tf.setNodes({ assetId, contentType, name, sizeBytes }, { at });
    } catch (cause) {
      if (deferStorageRefusal(cause)) return;
      userToast({
        description: isStorageQuotaError(cause)
          ? m.editor_storage_quota()
          : errorCopy(cause, m.source_try_again()),
        title: m.editor_upload_failed(),
        variant: 'error',
      });
    } finally {
      setReplacing(false);
    }
  };

  const { openFilePicker } = useFilePicker({
    accept: [MEDIA_ACCEPT.image],
    multiple: false,
    onFilesSelected: ({ plainFiles }) => {
      if (plainFiles[0]) void replace(plainFiles[0]);
    },
  });

  return (
    <>
      {!readOnly && (
        <ToolbarButton
          label={m.editor_caption_add()}
          onClick={() => {
            // Mount the caption field, then let CaptionTextarea focus itself.
            editor.setOption(CaptionPlugin, 'visibleId', node.id as string);
            const path = editor.api.findPath(node);
            setTimeout(() => {
              if (path) editor.setOption(CaptionPlugin, 'focusEndPath', path);
            });
          }}
          tooltipSide="top"
        >
          <EditorIcon name="closedCaption" />
        </ToolbarButton>
      )}
      {element.assetId && (
        <ToolbarButton
          label={m.media_open_new_tab()}
          onClick={() => openEditorAsset(element.assetId!)}
          tooltipSide="top"
        >
          <EditorIcon name="externalLink" />
        </ToolbarButton>
      )}
      {!readOnly && allowExternalAssets && (
        <ToolbarButton
          disabled={replacing}
          label={m.editor_image_replace()}
          onClick={openFilePicker}
          tooltipSide="top"
        >
          <EditorIcon
            className={cn(replacing && 'animate-spin')}
            name={replacing ? 'loader' : 'pencil'}
          />
        </ToolbarButton>
      )}
    </>
  );
}

export function YouTubeEmbedElement(props: PlateElementProps) {
  const element = props.element as unknown as YouTubeNode;
  const readOnly = useReadOnly();
  const videoId =
    typeof element.videoId === 'string' ? element.videoId : undefined;

  return (
    <PlateElement
      {...props}
      className={cn(
        'my-3',
        !videoId && 'rounded-card border border-solid-error/30'
      )}
    >
      <div contentEditable={false}>
        {videoId ? (
          <MediaFrame
            fill
            onWidthChange={
              readOnly
                ? undefined
                : (width) =>
                    props.editor.tf.setNodes({ width }, { at: props.path })
            }
            toolbar={
              <>
                <ToolbarButton
                  asChild
                  label={m.youtube_open()}
                  tooltipSide="top"
                >
                  <a
                    href={youtubeWatchUrl(videoId)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <EditorIcon name="externalLink" />
                  </a>
                </ToolbarButton>
                {!readOnly && (
                  <YouTubeLinkEditor
                    onSave={(next) =>
                      props.editor.tf.setNodes(
                        { videoId: next },
                        { at: props.path }
                      )
                    }
                    videoId={videoId}
                  />
                )}
              </>
            }
            width={element.width}
          >
            <YouTubeEmbed videoId={videoId} />
          </MediaFrame>
        ) : (
          <p className="p-3 text-sm text-solid-error">
            {m.youtube_missing_id()}
          </p>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}

function YouTubeLinkEditor({
  videoId,
  onSave,
}: {
  videoId: string;
  onSave: (videoId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        setUrl(youtubeWatchUrl(videoId));
        setInvalid(false);
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <ToolbarButton
          active={open}
          label={m.editor_youtube_edit()}
          tooltipSide="top"
        >
          <EditorIcon name="pencil" />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-0 p-1"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = youtubeVideoId(url);
            if (!next) {
              setInvalid(true);
              return;
            }
            if (next !== videoId) onSave(next);
            setOpen(false);
          }}
        >
          <Input
            aria-invalid={invalid}
            aria-label={m.editor_youtube_link()}
            autoFocus
            className="h-7 py-1 font-medium text-sm"
            leftIcon="link"
            onChange={(event) => {
              setUrl(event.target.value);
              setInvalid(false);
            }}
            placeholder="https://youtu.be/…"
            value={url}
            variant="transparent"
            wrapperClassName={cn(
              'rounded-none px-2 focus-within:bg-surface-hover-bg/40 [&_svg]:size-4',
              invalid && 'ring-1 ring-solid-error'
            )}
          />
          <Separator className="my-1" />
          <div className="flex items-center justify-end gap-0">
            <ToolbarButton
              label={m.editor_link_save()}
              tooltipSide="top"
              type="submit"
            >
              <EditorIcon name="check" />
            </ToolbarButton>
            <ToolbarButton
              label={m.editor_link_cancel()}
              onClick={() => setOpen(false)}
              tooltipSide="top"
              type="button"
            >
              <EditorIcon name="x" />
            </ToolbarButton>
          </div>
          {invalid && (
            <p
              className="mt-1.5 px-2 pb-1 text-solid-error text-xs"
              role="alert"
            >
              {m.editor_youtube_invalid()}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}
