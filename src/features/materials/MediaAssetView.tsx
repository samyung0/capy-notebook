import { FileText, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { resolveEditorAsset } from '@/api/editorAssets';

/** Persisted media node shape for workspace-backed asset elements. */
export interface MediaAssetNode {
  assetId?: string;
  name?: string;
  type: string;
  width?: string | number;
}

type AssetState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; name: string; contentType: string }
  | { status: 'error'; message: string };

export function useResolvedAsset(assetId: string | undefined) {
  const [state, setState] = useState<AssetState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    if (!assetId) {
      setState({ message: 'Missing asset reference', status: 'error' });
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
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setState({
            message:
              cause instanceof Error ? cause.message : 'Unable to load asset',
            status: 'error',
          });
        }
      });
    return () => controller.abort();
  }, [assetId]);

  return state;
}

/** Presentational media renderer shared by the editable node component and the
 * static preview. Resolves the asset URL and renders by media type. */
export function MediaAssetView({ element }: { element: MediaAssetNode }) {
  const asset = useResolvedAsset(element.assetId);
  return (
    <figure className="group relative m-0" contentEditable={false}>
      {asset.status === 'loading' && (
        <div className="grid min-h-24 place-items-center rounded-card border border-line bg-surface-hover-bg">
          <LoaderCircle className="size-5 animate-spin text-fg-muted" />
        </div>
      )}
      {asset.status === 'error' && (
        <div className="rounded-card border border-solid-error/30 bg-tint-error px-3 py-4 text-sm text-solid-error">
          {asset.message}
        </div>
      )}
      {asset.status === 'ready' && element.type === 'img' && (
        <img
          alt={element.name || asset.name}
          className="mx-auto h-auto max-w-full rounded-card"
          src={asset.url}
          style={{ width: element.width }}
        />
      )}
      {asset.status === 'ready' && element.type === 'audio' && (
        <audio className="w-full" controls src={asset.url} />
      )}
      {asset.status === 'ready' && element.type === 'file' && (
        <a
          className="flex items-center gap-2 rounded-card border border-line bg-surface-hover-bg px-3 py-2 text-fg text-sm hover:border-line-strong"
          href={asset.url}
          rel="noreferrer"
          target="_blank"
        >
          <FileText className="size-4 text-fg-muted" />
          <span className="truncate">{element.name || asset.name}</span>
        </a>
      )}
    </figure>
  );
}
