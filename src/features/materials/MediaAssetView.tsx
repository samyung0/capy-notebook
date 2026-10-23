import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { onChildrenReady } from '@/features/notes/childrenReady';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MediaFrame } from './MediaFrame';

// Loaded when used: the authenticated resolve (with the app's query client
// behind it) only where no AssetUrlContext answers, which is never on a shared
// page, and the full-screen preview on its first open.
const resolveEditorAsset = (assetId: string, signal?: AbortSignal) =>
  import('@/api/editorAssets').then((mod) =>
    mod.resolveEditorAsset(assetId, signal)
  );
const MediaPreview = lazy(() =>
  import('./MediaPreview').then((mod) => ({ default: mod.MediaPreview }))
);

/** Persisted media node shape for workspace-backed asset elements. */
export interface MediaAssetNode {
  assetId?: string;
  caption?: { text: string }[];
  name?: string;
  type: string;
  width?: string | number;
}

type AssetState =
  | { status: 'loading' }
  | {
      status: 'ready';
      url: string;
      name: string;
      contentType: string;
      materialId?: string;
    }
  | { status: 'error'; kind: 'missing' | 'failed' | 'removed' };

/** Overrides where an editor asset loads from: shared pages use the site
 * Worker's share route, and the quiz editor shows images picked but not yet
 * uploaded. Undefined falls back to the authenticated resolve endpoint. */
export const AssetUrlContext = createContext<
  ((assetId: string) => string | undefined) | null
>(null);

/** The images and audio the open material shows that no longer exist (its
 * `removedAssetIds`): deleted by their uploader, or with the uploader's
 * account (M16). Each renders as removed instead of loading. */
export const RemovedAssetsContext = createContext<ReadonlySet<string>>(
  new Set()
);

export function useResolvedAsset(assetId: string | undefined) {
  const [state, setState] = useState<AssetState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const resolveUrl = useContext(AssetUrlContext);
  const override = assetId ? resolveUrl?.(assetId) : undefined;
  const removedIds = useContext(RemovedAssetsContext);
  const removed = !!assetId && removedIds.has(assetId);

  useEffect(() => {
    const controller = new AbortController();
    if (override || removed) return;
    if (!assetId) {
      setState({ kind: 'missing', status: 'error' });
      return () => controller.abort();
    }
    setState({ status: 'loading' });
    void resolveEditorAsset(assetId, controller.signal)
      .then((asset) => {
        setState({
          contentType: asset.contentType,
          materialId: asset.materialId,
          name: asset.name,
          status: 'ready',
          url: asset.url,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({
            kind: 'failed',
            status: 'error',
          });
        }
      });
    return () => controller.abort();
  }, [assetId, generation, override, removed]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const known: AssetState | undefined = removed
    ? { kind: 'removed', status: 'error' }
    : override
      ? { contentType: '', name: '', status: 'ready', url: override }
      : undefined;
  return [known ?? state, reload] as const;
}

/** An image or audio clip its uploader deleted (M16), in the look of an empty
 * media block. */
export function RemovedMedia({
  audio = false,
  className,
}: {
  audio?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-18 items-center gap-3 rounded-card border border-line border-dashed bg-surface-hover-bg px-4 py-3 text-fg-muted text-sm',
        className
      )}
      role="note"
    >
      <Icon className="size-5 shrink-0" name={audio ? 'fileAudio' : 'image'} />
      <p className="min-w-0">
        {audio ? m.media_audio_removed() : m.media_image_removed()}
      </p>
    </div>
  );
}

/** Signed when clicked, not when rendered: open the tab first so the
 * navigation stays inside the click's popup allowance. */
export function openEditorAsset(assetId: string) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  resolveEditorAsset(assetId).then(
    (resolved) => {
      if (tab) tab.location.href = resolved.url;
    },
    () => tab?.close()
  );
}

/** Presentational media renderer shared by the editable node component and the
 * static preview. Resolves the asset URL and renders by media type. Images get
 * the hover `toolbar`, optional resize handles and a `caption` slot.
 *
 * A node is a skeleton while its asset resolves (so a finished upload's
 * skeleton gives way to the image itself). In an editable note (`ownerId`) it
 * also waits as one until its asset is the note's own: another note's
 * (pasted) until the collaboration service repoints it to a copy, a trashed
 * one (undo, cut and paste) until the service restores it and says so
 * (childrenReady.ts). */
export function MediaAssetView({
  caption,
  element,
  onWidthChange,
  ownerId,
  toolbar,
}: {
  caption?: ReactNode;
  element: MediaAssetNode;
  onWidthChange?: (width: string) => void;
  ownerId?: string;
  toolbar?: ReactNode;
}) {
  const [asset, reload] = useResolvedAsset(element.assetId);
  const { assetId } = element;
  useEffect(() => {
    if (!(ownerId && assetId)) return;
    return onChildrenReady((ready) => {
      if (ready.assetIds.includes(assetId)) reload();
    });
  }, [assetId, ownerId, reload]);
  const waiting =
    !!ownerId &&
    ((asset.status === 'error' && asset.kind !== 'removed') ||
      (asset.status === 'ready' &&
        !!asset.materialId &&
        asset.materialId !== ownerId));
  // An SVG without width/height has no intrinsic width and collapses in a
  // fit-to-image frame, so it fills the block instead.
  const [fill, setFill] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number>();
  const [previewing, setPreviewing] = useState(false);
  // Mounted from the first open on, so closing still animates.
  const [previewed, setPreviewed] = useState(false);
  // A presigned URL is short-lived; seeking past the buffered range re-reads
  // it. Re-resolve once, then let a second failure surface. The audio mounts
  // again either way: a shared page's URL stays its share route, which
  // redirects to a fresh link.
  const [retried, setRetried] = useState(false);
  const onMediaError = () => {
    if (retried) return;
    setRetried(true);
    reload();
  };
  return (
    <figure className="group relative m-0" contentEditable={false}>
      {(asset.status === 'loading' || waiting) && (
        <Skeleton className="h-24 w-full rounded-card" />
      )}
      {asset.status === 'error' && asset.kind === 'removed' && (
        <RemovedMedia audio={element.type === 'audio'} />
      )}
      {asset.status === 'error' && asset.kind !== 'removed' && !waiting && (
        <div className="rounded-card border border-solid-error/30 bg-tint-error px-3 py-4 text-sm text-solid-error">
          {asset.kind === 'missing'
            ? m.material_missing_asset()
            : m.material_asset_failed()}
        </div>
      )}
      {asset.status === 'ready' && !waiting && element.type === 'img' && (
        <MediaFrame
          aspectRatio={aspectRatio}
          fill={fill}
          onOpen={() => {
            setPreviewed(true);
            setPreviewing(true);
          }}
          onWidthChange={onWidthChange}
          toolbar={toolbar}
          width={element.width}
        >
          <img
            alt={element.name || asset.name}
            className={cn(
              'block h-auto rounded-card',
              element.width || fill ? 'w-full' : 'max-w-full'
            )}
            decoding="async"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!image.offsetWidth) setFill(true);
              if (image.naturalWidth && image.naturalHeight)
                setAspectRatio(image.naturalWidth / image.naturalHeight);
            }}
            src={asset.url}
          />
        </MediaFrame>
      )}
      {asset.status === 'ready' &&
        !waiting &&
        element.type === 'img' &&
        previewed && (
          <Suspense fallback={null}>
            <MediaPreview
              caption={element.caption?.map((node) => node.text).join('')}
              onOpenChange={setPreviewing}
              open={previewing}
              title={element.name || asset.name}
            >
              <img
                alt={element.name || asset.name}
                className={cn(
                  'max-h-full max-w-full rounded-card',
                  // No intrinsic size: take the height, width from the viewBox.
                  fill && 'h-full w-auto'
                )}
                src={asset.url}
              />
            </MediaPreview>
          </Suspense>
        )}
      {asset.status === 'ready' && !waiting && element.type === 'audio' && (
        <audio
          className="w-full"
          controls
          key={`${asset.url} ${retried}`}
          onError={onMediaError}
          src={asset.url}
        />
      )}
      {caption}
    </figure>
  );
}
