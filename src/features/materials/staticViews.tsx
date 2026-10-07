import { lazy, type ReactNode, Suspense, useContext, useState } from 'react';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { MEDIA_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import type {
  HtmlEmbedElement,
  MaterialRefElement,
  MermaidElement,
  QuestionFigureElement,
} from './document';
import { EmbedLoading, EmbedViewContext } from './embeds/EmbedView';
import { HtmlEmbed } from './HtmlEmbed';
import { PublicPageContext } from './Island';
import {
  AssetUrlContext,
  type MediaAssetNode,
  MediaAssetView,
  openEditorAsset,
} from './MediaAssetView';
import { MediaFrame } from './MediaFrame';
import { MediaPreview, MermaidPreview } from './MediaPreview';
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

/** Unresized charts open at their question-figure width (max-w-md). */
const CHART_WIDTH = '28rem';

/** A chart or graph with its click-to-preview. The editor adds its toolbar
 * and resize handles. */
export function FigureView({
  block,
  onWidthChange,
  toolbar,
  width,
}: Pick<QuestionFigureElement, 'block' | 'width'> & {
  onWidthChange?: (width: string) => void;
  toolbar?: ReactNode;
}) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <MediaFrame
        aspectRatio={
          block.type === 'graph' ? block.width / block.height : undefined
        }
        onOpen={() => setPreviewing(true)}
        onWidthChange={onWidthChange}
        toolbar={toolbar}
        width={width ?? (block.type === 'chart' ? CHART_WIDTH : block.width)}
      >
        {/* The figure fills the frame so the handles scale it. */}
        <div className="[&_figure]:my-0 [&_figure]:w-full [&_figure]:max-w-none [&_img]:w-full">
          <QuestionBlockView block={block} />
        </div>
      </MediaFrame>
      <MediaPreview
        onOpenChange={setPreviewing}
        open={previewing}
        title={block.type === 'chart' ? m.editor_chart() : m.editor_graph()}
      >
        {block.type === 'chart' ? (
          // Chart text uses the page colours, so it keeps a page-coloured panel.
          <div className="w-[min(100%,56rem)] rounded-card bg-surface p-6 text-fg [&_figure]:my-0 [&_figure]:max-w-none">
            <QuestionBlockView block={block} />
          </div>
        ) : (
          <div className="max-h-full max-w-full [&_img]:h-[calc(100dvh-10rem)] [&_img]:w-auto [&_img]:max-w-full">
            <QuestionBlockView block={block} />
          </div>
        )}
      </MediaPreview>
    </>
  );
}

const HtmlEmbedSourceDialog = lazy(
  () => import('@/features/notes/blocks/HtmlEmbedSourceDialog')
);

/** An interactive HTML block in its sandboxed frame, with View source in the
 * app. */
export function HtmlEmbedView({
  caption,
  html,
  id,
}: Pick<HtmlEmbedElement, 'caption' | 'html' | 'id'>) {
  const [viewing, setViewing] = useState(false);
  const publicPage = useContext(PublicPageContext);
  return (
    <>
      <HtmlEmbed
        caption={caption}
        html={html}
        id={id}
        toolbar={
          !publicPage && (
            <ToolbarButton
              label={m.html_embed_view_source()}
              onClick={() => setViewing(true)}
              tooltipSide="top"
            >
              <EditorIcon name="code" />
            </ToolbarButton>
          )
        }
      />
      {viewing && (
        <Suspense fallback={null}>
          <HtmlEmbedSourceDialog
            html={html}
            onClose={() => setViewing(false)}
          />
        </Suspense>
      )}
    </>
  );
}
