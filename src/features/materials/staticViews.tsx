import { lazy, Suspense, useContext, useState } from 'react';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { MEDIA_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import type {
  HtmlEmbedElement,
  MaterialRefElement,
  MermaidElement,
} from './document';
import { EmbedLoading, EmbedViewContext } from './embeds/EmbedView';
import { HtmlEmbed } from './HtmlEmbed';
import {
  AssetUrlContext,
  type MediaAssetNode,
  MediaAssetView,
  openEditorAsset,
} from './MediaAssetView';
import { MediaFrame } from './MediaFrame';
import { MermaidPreview } from './MediaPreview';
import { Mermaid } from './Mermaid';

/* The read-only blocks that need the browser, apart from their Slate
   elements (staticNodeComponents.tsx) and free of Plate, so a server-rendered
   shared note hydrates them as islands without loading the renderer. */

/** An image, audio or file with its caption and an open-in-new-tab action. */
export function StaticMediaAsset({ element }: { element: MediaAssetNode }) {
  const assetUrl = useContext(AssetUrlContext);
  const caption = element.caption?.map((node) => node.text).join('');
  // Shared pages know the URL; the app signs one when clicked.
  const href = element.assetId && assetUrl?.(element.assetId);
  return (
    <MediaAssetView
      caption={
        caption && (
          <figcaption
            className={MEDIA_CAPTION_CLASS}
            style={{ width: element.width }}
          >
            {caption}
          </figcaption>
        )
      }
      element={element}
      toolbar={
        element.assetId &&
        (href ? (
          <ToolbarButton
            asChild
            label={m.media_open_new_tab()}
            tooltipSide="top"
          >
            <a href={href} rel="noreferrer" target="_blank">
              <EditorIcon name="externalLink" />
            </a>
          </ToolbarButton>
        ) : (
          <ToolbarButton
            label={m.media_open_new_tab()}
            onClick={() => openEditorAsset(element.assetId!)}
            tooltipSide="top"
          >
            <EditorIcon name="externalLink" />
          </ToolbarButton>
        ))
      }
    />
  );
}

/** An embedded quiz or flashcard set, studied in place with the page's own
 * embed renderer (EmbedViewContext). */
export function EmbedSlot({
  materialId,
  refKind,
}: Pick<MaterialRefElement, 'materialId' | 'refKind'>) {
  const Embed = useContext(EmbedViewContext);
  return (
    <Suspense fallback={<EmbedLoading />}>
      <Embed materialId={materialId} refKind={refKind} />
    </Suspense>
  );
}

/** A diagram, rendered in the browser (Mermaid needs a DOM), with its
 * click-to-preview. */
export function MermaidView({
  caption,
  source,
  theme,
  width,
}: {
  caption: string;
} & Pick<MermaidElement, 'source' | 'theme' | 'width'>) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <MediaFrame fill onOpen={() => setPreviewing(true)} width={width}>
        <Mermaid code={source} fill={width !== undefined} theme={theme} />
      </MediaFrame>
      <MermaidPreview
        caption={caption}
        code={source}
        onOpenChange={setPreviewing}
        open={previewing}
        theme={theme}
      />
    </>
  );
}

const HtmlEmbedSourceDialog = lazy(
  () => import('@/features/notes/blocks/HtmlEmbedSourceDialog')
);

/** An interactive HTML block in its sandboxed frame, with View source. */
export function HtmlEmbedView({
  html,
  id,
  title,
}: Pick<HtmlEmbedElement, 'html' | 'id' | 'title'>) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      <HtmlEmbed
        html={html}
        id={id}
        title={title}
        toolbar={
          <ToolbarButton
            label={m.html_embed_view_source()}
            onClick={() => setViewing(true)}
            tooltipSide="top"
          >
            <EditorIcon name="code" />
          </ToolbarButton>
        }
      />
      {viewing && (
        <Suspense fallback={null}>
          <HtmlEmbedSourceDialog
            html={html}
            onClose={() => setViewing(false)}
            title={title}
          />
        </Suspense>
      )}
    </>
  );
}
