import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { resolveEditorAsset } from '@/api/editorAssets';
import { Skeleton } from '@/components/ui/feedback';
import { onChildrenReady } from '@/features/notes/childrenReady';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MediaFrame } from './MediaFrame';
import { MediaPreview } from './MediaPreview';

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
  | { status: 'error'; kind: 'missing' | 'failed' };

/** Overrides where an editor asset loads from: shared pages use the site
 * Worker's share route, and the quiz editor shows images picked but not yet
 * uploaded. Undefined falls back to the authenticated resolve endpoint. */
export const AssetUrlContext = createContext<
  ((assetId: string) => string | undefined) | null
>(null);

export function useResolvedAsset(assetId: string | undefined) {
  const [state, setState] = useState<AssetState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const resolveUrl = useContext(AssetUrlContext);
  const override = assetId ? resolveUrl?.(assetId) : undefined;

  useEffect(() => {
    const controller = new AbortController();
    if (override) return;
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
  }, [assetId, generation, override]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const ready: AssetState | undefined = override
    ? { contentType: '', name: '', status: 'ready', url: override }
    : undefined;
  return [ready ?? state, reload] as const;
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
 * In an editable note (`ownerId`) a node waits as a skeleton until its asset is
 * the note's own: another note's (pasted) until the collaboration service
 * repoints it to a copy, a trashed one (undo, cut and paste) until the service
 * restores it and says so (childrenReady.ts). */
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
    (asset.status === 'error' ||
      (asset.status === 'ready' &&
        !!asset.materialId &&
        asset.materialId !== ownerId));
  // An SVG without width/height has no intrinsic width and collapses in a
  // fit-to-image frame, so it fills the block instead.
  const [fill, setFill] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number>();
  const [previewing, setPreviewing] = useState(false);
  // A presigned URL is short-lived; seeking past the buffered range re-reads
  // it. Re-resolve once, then let a second failure surface.
  const retried = useRef(false);
  const onMediaError = () => {
    if (retried.current) return;
    retried.current = true;
    reload();
  };
  const openFile = () => {
    if (element.assetId) openEditorAsset(element.assetId);
  };
  return (
    <figure className="group relative m-0" contentEditable={false}>
      {asset.status === 'loading' && (
        <div className="grid min-h-24 place-items-center rounded-card border border-line bg-surface-hover-bg">
          <EditorIcon
            className="size-5 animate-spin text-fg-muted"
            name="loader"
          />
        </div>
      )}
      {waiting && <Skeleton className="h-24 w-full rounded-card" />}
      {asset.status === 'error' && !waiting && (
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
          onOpen={() => setPreviewing(true)}
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
            // Long notes load images as the reader scrolls to them.
            loading="lazy"
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
      {asset.status === 'ready' && !waiting && element.type === 'img' && (
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
      )}
      {asset.status === 'ready' && !waiting && element.type === 'audio' && (
        <audio
          className="w-full"
          controls
          key={asset.url}
          onError={onMediaError}
          src={asset.url}
        />
      )}
      {asset.status === 'ready' && !waiting && element.type === 'file' && (
        <button
          className="flex w-full items-center gap-2 rounded-card border border-line bg-surface-hover-bg px-3 py-2 text-fg text-sm hover:border-line-strong"
          onClick={openFile}
          type="button"
        >
          <EditorIcon className="size-4 text-fg-muted" name="fileText" />
          <span className="truncate">{element.name || asset.name}</span>
        </button>
      )}
      {caption}
    </figure>
  );
}
