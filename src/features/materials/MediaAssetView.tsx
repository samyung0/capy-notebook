import { type ReactNode, useEffect, useRef, useState } from 'react';
import { resolveEditorAsset } from '@/api/editorAssets';
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
  | { status: 'ready'; url: string; name: string; contentType: string }
  | { status: 'error'; kind: 'missing' | 'failed' };

export function useResolvedAsset(assetId: string | undefined) {
  const [state, setState] = useState<AssetState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    if (!assetId) {
      setState({ kind: 'missing', status: 'error' });
      return () => controller.abort();
    }
    setState({ status: 'loading' });
    void resolveEditorAsset(assetId, controller.signal)
      .then((asset) =>
        setState({
          contentType: asset.contentType,
          name: asset.name,
          status: 'ready',
          url: asset.url,
        })
      )
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({
            kind: 'failed',
            status: 'error',
          });
        }
      });
    return () => controller.abort();
  }, [assetId, generation]);

  return [state, () => setGeneration((value) => value + 1)] as const;
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
 * the hover `toolbar`, optional resize handles and a `caption` slot. */
export function MediaAssetView({
  caption,
  element,
  onWidthChange,
  toolbar,
}: {
  caption?: ReactNode;
  element: MediaAssetNode;
  onWidthChange?: (width: string) => void;
  toolbar?: ReactNode;
}) {
  const [asset, reload] = useResolvedAsset(element.assetId);
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
      {asset.status === 'error' && (
        <div className="rounded-card border border-solid-error/30 bg-tint-error px-3 py-4 text-sm text-solid-error">
          {asset.kind === 'missing'
            ? m.material_missing_asset()
            : m.material_asset_failed()}
        </div>
      )}
      {asset.status === 'ready' && element.type === 'img' && (
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
      {asset.status === 'ready' && element.type === 'img' && (
        <MediaPreview
          caption={element.caption?.map((node) => node.text).join('')}
          onOpenChange={setPreviewing}
          open={previewing}
          title={element.name || asset.name}
        >
          <img
            alt={element.name || asset.name}
            className={cn(
              'max-h-full max-w-full rounded-card object-contain',
              fill && 'size-full'
            )}
            src={asset.url}
          />
        </MediaPreview>
      )}
      {asset.status === 'ready' && element.type === 'audio' && (
        <audio
          className="w-full"
          controls
          key={asset.url}
          onError={onMediaError}
          src={asset.url}
        />
      )}
      {asset.status === 'ready' && element.type === 'file' && (
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
