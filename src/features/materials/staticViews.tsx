import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useState,
} from 'react';
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
import { MERMAID_TYPING_DELAY_MS, Mermaid } from './Mermaid';
import { previewHeight } from './previewHeight';

/* The read-only blocks that need the browser, apart from their Slate
   elements (staticNodeComponents.tsx) and free of Plate, so a server-rendered
   shared note hydrates them as islands without loading the renderer. */

// The full-screen previews (zoom library, dialog) load on their first open and
// stay mounted from then on, so closing still animates.
const MediaPreview = lazy(() =>
  import('./MediaPreview').then((mod) => ({ default: mod.MediaPreview }))
);
const MermaidPreview = lazy(() =>
  import('./MediaPreview').then((mod) => ({ default: mod.MermaidPreview }))
);

/** `open` for a preview, and whether it has been opened yet. */
function usePreview() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return {
    onOpen: () => {
      setOpened(true);
      setOpen(true);
    },
    open,
    opened,
    setOpen,
  };
}

/** An image or audio with its caption and an open-in-new-tab action. */
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
 * double-click preview. */
export function MermaidView({
  caption,
  source,
  theme,
  title,
  width,
}: {
  caption: string;
  /** Names the full-screen view; a block in a note leaves it to the context. */
  title?: string;
} & Pick<MermaidElement, 'source' | 'theme' | 'width'>) {
  const preview = usePreview();
  // A diagram that cannot be drawn shows its error, with nothing to enlarge.
  const [drawn, setDrawn] = useState(false);
  return (
    <>
      <MediaFrame
        fill
        onOpen={drawn ? preview.onOpen : undefined}
        width={width}
      >
        <Mermaid
          code={source}
          // A live note View follows a source typed elsewhere.
          delay={MERMAID_TYPING_DELAY_MS}
          fill={width !== undefined}
          onDrawn={setDrawn}
          theme={theme}
        />
      </MediaFrame>
      {preview.opened && (
        <Suspense fallback={null}>
          <MermaidPreview
            caption={caption}
            code={source}
            onOpenChange={preview.setOpen}
            open={preview.open}
            theme={theme}
            title={title}
          />
        </Suspense>
      )}
    </>
  );
}

/** Unresized charts open at their question-figure width (max-w-md). */
const CHART_WIDTH = '28rem';

/** A chart, plot or graph with its double-click preview. The editor adds its
 * toolbar and resize handles. */
export function FigureView({
  block,
  onWidthChange,
  toolbar,
  width,
}: Pick<QuestionFigureElement, 'block' | 'width'> & {
  onWidthChange?: (width: string) => void;
  toolbar?: ReactNode;
}) {
  const preview = usePreview();
  return (
    <>
      <MediaFrame
        aspectRatio={
          block.type === 'graph' ? block.width / block.height : undefined
        }
        onOpen={preview.onOpen}
        onWidthChange={onWidthChange}
        toolbar={toolbar}
        width={width ?? (block.type === 'graph' ? block.width : CHART_WIDTH)}
      >
        {/* The figure fills the frame so the handles scale it. */}
        <div className="[&_figure]:my-0 [&_figure]:w-full [&_figure]:max-w-none [&_img]:w-full">
          <QuestionBlockView block={block} />
        </div>
      </MediaFrame>
      {/* A figure's description reads as its caption, like an image's. */}
      {block.description && (
        <p
          className={MEDIA_CAPTION_CLASS}
          style={{
            width:
              width ?? (block.type === 'graph' ? block.width : CHART_WIDTH),
          }}
        >
          {block.description}
        </p>
      )}
      {preview.opened && (
        <Suspense fallback={null}>
          <MediaPreview
            onOpenChange={preview.setOpen}
            open={preview.open}
            title={
              block.type === 'chart'
                ? m.editor_chart()
                : block.type === 'plot'
                  ? m.question_ui_plot()
                  : m.editor_graph()
            }
          >
            {block.type === 'graph' ? (
              <div
                className="[&_img]:h-(--preview-height) [&_img]:w-auto"
                style={
                  {
                    '--preview-height': previewHeight(
                      block.width,
                      block.height
                    ),
                  } as CSSProperties
                }
              >
                <QuestionBlockView block={block} />
              </div>
            ) : (
              // Chart text uses the page colours, so it keeps a page-coloured panel.
              <div className="w-[min(100%,56rem)] rounded-card bg-surface p-6 text-fg [&_figure]:my-0 [&_figure]:max-w-none">
                <QuestionBlockView block={block} />
              </div>
            )}
          </MediaPreview>
        </Suspense>
      )}
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
