/* Static (read-only) note document components. Rendered by PlateStatic without
 * a Plate store: no Plate hooks, no editor transforms, no edit affordances.
 * Styling is shared with the editable components via nodeStyles. */

import { getTableColumnCount } from '@platejs/table';
import { KEYS, NodeApi, type Path, type TTableElement } from 'platejs';
import {
  SlateElement,
  type SlateElementProps,
  SlateLeaf,
  type SlateLeafProps,
} from 'platejs/static';
import type { CSSProperties, MouseEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { CalloutIcon } from '@/features/notes/CalloutIcon';
import { EditorIcon } from '@/features/notes/EditorIcon';
import {
  BLOCKQUOTE_CLASS,
  BOLD_MARK_CLASS,
  CALLOUT_CLASS,
  CODE_BLOCK_CLASS,
  CODE_LINE_CLASS,
  CODE_MARK_CLASS,
  COLUMN_CLASS,
  COLUMN_GROUP_CLASS,
  EQUATION_BLOCK_CLASS,
  FLASHCARD_BACK_CLASS,
  FLASHCARD_CLASS,
  FLASHCARD_FRONT_CLASS,
  HEADING_CLASS,
  HIGHLIGHT_MARK_CLASS,
  HR_CLASS,
  ITALIC_MARK_CLASS,
  KBD_MARK_CLASS,
  LI_CLASS,
  LINK_CLASS,
  MEDIA_CAPTION_CLASS,
  MENTION_CLASS,
  MERMAID_CAPTION_CLASS,
  OL_CLASS,
  PARAGRAPH_CLASS,
  QUIZ_REVIEW_QUESTION_CLASS,
  STUDY_BLOCK_LIST_CLASS,
  TABLE_CLASS,
  TABLE_WRAP_CLASS,
  TD_CLASS,
  TH_CLASS,
  TOC_BOX_CLASS,
  TOC_EMPTY_CLASS,
  TOC_ITEM_CLASS,
  tocItemIndent,
  UL_CLASS,
} from '@/features/notes/nodeStyles';
import {
  CALLOUT_CONTAINER_CLASS,
  CALLOUT_VARIANT_CLASS,
  getCodeBlockLanguageLabel,
  normalizeCalloutVariant,
} from '@/features/notes/richBlockConfig';
import {
  QuestionBlockView,
  QuestionView,
} from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type {
  FlashcardElement as FlashcardNode,
  MaterialRefElement as MaterialRefNode,
  MermaidElement as MermaidNode,
  QuestionFigureElement,
  QuizQuestionElement as QuizQuestionNode,
} from './document';
import { quizQuestionElementToQuestion } from './document';
import { MaterialRefCard } from './MaterialRefCard';
import { StandaloneMaterialTitle } from './MaterialRenderContext';
import { MathPreview } from './MathPreview';
import {
  type MediaAssetNode,
  MediaAssetView,
  openEditorAsset,
} from './MediaAssetView';
import { MediaFrame } from './MediaFrame';
import { Mermaid } from './Mermaid';
import {
  YouTubeEmbed,
  type YouTubeNode,
  youtubeWatchUrl,
} from './YouTubeEmbed';

/* ------------------------------------------------------------- helpers */

function element(
  as: keyof HTMLElementTagNameMap | undefined,
  className?: string
) {
  return function StaticEl(props: SlateElementProps) {
    return (
      <SlateElement {...props} as={as} className={className}>
        {props.children}
      </SlateElement>
    );
  };
}

function mark(as: keyof HTMLElementTagNameMap, className?: string) {
  return function StaticMark(props: SlateLeafProps) {
    return (
      <SlateLeaf {...props} as={as} className={className}>
        {props.children}
      </SlateLeaf>
    );
  };
}

/* ------------------------------------------------------------- elements */

function Hr(props: SlateElementProps) {
  return (
    <SlateElement {...props}>
      <div className="py-6">
        <hr className={HR_CLASS} />
      </div>
      {props.children}
    </SlateElement>
  );
}

function CodeBlock(props: SlateElementProps) {
  const language = (props.element as { lang?: unknown }).lang;
  return (
    <SlateElement
      {...props}
      as="pre"
      className={cn(
        CODE_BLOCK_CLASS,
        !(typeof language === 'string' && language) && 'pt-3'
      )}
    >
      {typeof language === 'string' && language && (
        <span className="absolute top-2 right-2 font-sans text-[11px] text-fg-muted">
          {getCodeBlockLanguageLabel(language)}
        </span>
      )}
      {props.children}
    </SlateElement>
  );
}

function LinkElement(props: SlateElementProps) {
  return (
    <SlateElement
      {...props}
      as="a"
      attributes={
        {
          ...props.attributes,
          rel: 'noopener noreferrer',
          target: '_blank',
        } as SlateElementProps['attributes']
      }
      className={LINK_CLASS}
    >
      {props.children}
    </SlateElement>
  );
}

function Table(props: SlateElementProps) {
  const table = props.element as TTableElement;
  const colSizes = Array.from(
    { length: getTableColumnCount(table) },
    (_, index) => table.colSizes?.[index] || 120
  );

  return (
    <SlateElement {...props} className={TABLE_WRAP_CLASS}>
      <table
        className={cn(TABLE_CLASS, 'table-fixed')}
        style={{ width: colSizes.reduce((total, width) => total + width, 0) }}
      >
        <colgroup>
          {colSizes.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <tbody>{props.children}</tbody>
      </table>
    </SlateElement>
  );
}

function Column(props: SlateElementProps) {
  const width = (props.element as { width?: string }).width;
  return (
    <SlateElement
      {...props}
      className={COLUMN_CLASS}
      style={width ? ({ '--column-width': width } as CSSProperties) : undefined}
    >
      {props.children}
    </SlateElement>
  );
}

function Callout(props: SlateElementProps) {
  const variant = normalizeCalloutVariant(
    (props.element as { variant?: unknown }).variant
  );
  return (
    <SlateElement
      {...props}
      className={cn(
        CALLOUT_CLASS,
        CALLOUT_CONTAINER_CLASS,
        CALLOUT_VARIANT_CLASS[variant]
      )}
      data-callout-variant={variant}
    >
      <CalloutIcon variant={variant} />
      <div className="min-w-0 flex-1 text-fg">{props.children}</div>
    </SlateElement>
  );
}

/* toc — scrolls the preview instead of moving an editor selection */
function scrollToHeading(event: MouseEvent, headingOrder: number) {
  const root = (event.currentTarget as HTMLElement).closest(
    '[data-slate-editor]'
  );
  if (!root) return;
  const heads = root.querySelectorAll(
    ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'
  );
  heads[headingOrder]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Toc(props: SlateElementProps) {
  const headings = props.editor.children.filter((node) =>
    KEYS.heading.includes(node.type as (typeof KEYS.heading)[number])
  );
  return (
    <SlateElement {...props} className={TOC_BOX_CLASS}>
      <div>
        {headings.length ? (
          <nav aria-label={m.toc_title()} className="flex flex-col gap-0">
            {headings.map((node, order) => (
              <Button
                className={TOC_ITEM_CLASS}
                key={(node.id as string | undefined) ?? order}
                onClick={(event) => scrollToHeading(event, order)}
                size="xs"
                style={tocItemIndent(node.type as string)}
                type="button"
                variant="ghost-hover"
              >
                {NodeApi.string(node)}
              </Button>
            ))}
          </nav>
        ) : (
          <p className={TOC_EMPTY_CLASS}>{m.toc_empty()}</p>
        )}
      </div>
      {props.children}
    </SlateElement>
  );
}

function Mention(props: SlateElementProps) {
  const mention = props.element as { key?: string; value?: string };
  const value = String(mention.value ?? mention.key ?? '');
  return (
    <SlateElement {...props} as="span" className={MENTION_CLASS}>
      <span>@{value}</span>
      {props.children}
    </SlateElement>
  );
}

function BlockEquation(props: SlateElementProps) {
  const tex = String(
    (props.element as { texExpression?: string }).texExpression ?? ''
  );
  return (
    <SlateElement {...props}>
      <div className={EQUATION_BLOCK_CLASS}>
        <MathPreview displayMode tex={tex} />
      </div>
      {props.children}
    </SlateElement>
  );
}

function InlineEquation(props: SlateElementProps) {
  const tex = String(
    (props.element as { texExpression?: string }).texExpression ?? ''
  );
  return (
    <SlateElement {...props} as="span">
      <MathPreview displayMode={false} tex={tex} />
      {props.children}
    </SlateElement>
  );
}

function CodeSyntax(props: SlateLeafProps) {
  const tokenClassName = props.leaf.className as string | undefined;

  return (
    <SlateLeaf {...props} as="span" className={tokenClassName}>
      {props.children}
    </SlateLeaf>
  );
}

function MediaAssetElement(props: SlateElementProps) {
  const element = props.element as unknown as MediaAssetNode;
  const caption = element.caption?.map((node) => node.text).join('');
  return (
    <SlateElement {...props} className="my-3">
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
          element.assetId && (
            <ToolbarButton
              label={m.media_open_new_tab()}
              onClick={() => openEditorAsset(element.assetId!)}
              tooltipSide="top"
            >
              <EditorIcon name="externalLink" />
            </ToolbarButton>
          )
        }
      />
      {props.children}
    </SlateElement>
  );
}

function YouTubeElement(props: SlateElementProps) {
  const element = props.element as unknown as YouTubeNode;
  return (
    <SlateElement {...props} className="my-3">
      <div contentEditable={false}>
        {element.videoId ? (
          <MediaFrame
            fill
            toolbar={
              <ToolbarButton asChild label={m.youtube_open()} tooltipSide="top">
                <a
                  href={youtubeWatchUrl(element.videoId)}
                  rel="noreferrer"
                  target="_blank"
                >
                  <EditorIcon name="externalLink" />
                </a>
              </ToolbarButton>
            }
            width={element.width}
          >
            <YouTubeEmbed videoId={element.videoId} />
          </MediaFrame>
        ) : (
          <p className="rounded-card border border-solid-error/30 p-3 text-sm text-solid-error">
            {m.youtube_missing_id()}
          </p>
        )}
      </div>
      {props.children}
    </SlateElement>
  );
}

/* ------------------------------------------------------------- study blocks */

function QuizElement(props: SlateElementProps) {
  return (
    <SlateElement {...props} className={STUDY_BLOCK_LIST_CLASS}>
      <StandaloneMaterialTitle kinds="quiz" />
      {props.children}
    </SlateElement>
  );
}

function FlashcardsElement(props: SlateElementProps) {
  return (
    <SlateElement {...props} className={cn(STUDY_BLOCK_LIST_CLASS, 'gap-2')}>
      <StandaloneMaterialTitle kinds="flashcards" />
      {props.children}
    </SlateElement>
  );
}

function MaterialRefElement(props: SlateElementProps) {
  const element = props.element as unknown as MaterialRefNode;
  return (
    <SlateElement {...props} className="my-4">
      <MaterialRefCard
        materialId={element.materialId}
        refKind={element.refKind}
      />
      {props.children}
    </SlateElement>
  );
}

function MermaidElement(props: SlateElementProps) {
  const element = props.element as unknown as MermaidNode;
  return (
    <SlateElement {...props} className="my-3 border border-transparent">
      <StandaloneMaterialTitle kinds={['mindmap', 'diagram']} />
      <Mermaid code={element.source} theme={element.theme} />
      {props.children}
    </SlateElement>
  );
}

function QuestionFigure(props: SlateElementProps) {
  const element = props.element as unknown as QuestionFigureElement;
  return (
    <SlateElement {...props} className="my-3 border border-transparent">
      <QuestionBlockView block={element.block} />
    </SlateElement>
  );
}

function QuizQuestionElement(props: SlateElementProps) {
  const node = props.element as unknown as QuizQuestionNode;
  const path = (props as { path?: Path }).path;
  const index = path?.[path.length - 1];
  return (
    <SlateElement {...props} className={QUIZ_REVIEW_QUESTION_CLASS}>
      <QuestionView
        question={quizQuestionElementToQuestion(node)}
        questionNumber={index == null ? undefined : index + 1}
        review
      />
    </SlateElement>
  );
}

function FlashcardElement(props: SlateElementProps) {
  const element = props.element as unknown as FlashcardNode;
  return (
    <SlateElement
      {...props}
      className={FLASHCARD_CLASS}
      data-card-id={element.id}
    >
      {props.children}
    </SlateElement>
  );
}

/* ------------------------------------------------------------- components map */

export const staticNoteComponents = {
  a: LinkElement,
  audio: MediaAssetElement,
  blockquote: element('blockquote', BLOCKQUOTE_CLASS),
  /* marks */
  bold: mark('strong', BOLD_MARK_CLASS),
  callout: Callout,
  chart: QuestionFigure,
  code: mark('code', CODE_MARK_CLASS),
  code_block: CodeBlock,
  code_line: element(undefined, CODE_LINE_CLASS),
  code_syntax: CodeSyntax,
  column: Column,
  column_group: element('div', COLUMN_GROUP_CLASS),
  equation: BlockEquation,
  file: MediaAssetElement,
  flashcard: FlashcardElement,
  flashcard_back: element('p', FLASHCARD_BACK_CLASS),
  flashcard_front: element('p', FLASHCARD_FRONT_CLASS),
  flashcards: FlashcardsElement,
  graph: QuestionFigure,
  h1: element('h1', HEADING_CLASS.h1),
  h2: element('h2', HEADING_CLASS.h2),
  h3: element('h3', HEADING_CLASS.h3),
  h4: element('h4', HEADING_CLASS.h4),
  h5: element('h5', HEADING_CLASS.h5),
  h6: element('h6', HEADING_CLASS.h6),
  highlight: mark('mark', HIGHLIGHT_MARK_CLASS),
  hr: Hr,
  img: MediaAssetElement,
  inline_equation: InlineEquation,
  italic: mark('em', ITALIC_MARK_CLASS),
  kbd: mark('kbd', KBD_MARK_CLASS),
  li: element('li', LI_CLASS),
  lic: element('span'),
  material_ref: MaterialRefElement,
  mention: Mention,
  mermaid: MermaidElement,
  mermaid_caption: element('p', MERMAID_CAPTION_CLASS),
  ol: element('ol', OL_CLASS),
  // Match editable Paragraph: default to div so indent-list belowNodes can
  // inject <ol>/<div> without nesting block elements inside <p>.
  p: element('div', PARAGRAPH_CLASS),
  /* study blocks */
  quiz: QuizElement,
  quiz_question: QuizQuestionElement,
  strikethrough: mark('s'),
  subscript: mark('sub'),
  superscript: mark('sup'),
  table: Table,
  td: element('td', TD_CLASS),
  th: element('th', TH_CLASS),
  toc: Toc,
  tr: element('tr'),
  ul: element('ul', UL_CLASS),
  underline: mark('u'),
  video: YouTubeElement,
} as const;
