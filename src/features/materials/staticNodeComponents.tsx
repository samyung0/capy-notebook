/* Static (read-only) note document components. Rendered by PlateStatic without
 * a Plate store: no Plate hooks, no editor transforms, no edit affordances.
 * Styling is shared with the editable components via nodeStyles. */

import { getTableColumnCount } from '@platejs/table';
import { CircleAlert, CircleCheck, CircleX, Info } from 'lucide-react';
import { KEYS, NodeApi, type Path, type TTableElement } from 'platejs';
import {
  SlateElement,
  type SlateElementProps,
  SlateLeaf,
  type SlateLeafProps,
} from 'platejs/static';
import type { CSSProperties, MouseEvent } from 'react';
import {
  BLOCK_SHELL_CLASS,
  BLOCKQUOTE_CLASS,
  BOLD_MARK_CLASS,
  CALLOUT_CLASS,
  CODE_BLOCK_CLASS,
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
  MENTION_CLASS,
  MERMAID_CAPTION_CLASS,
  OL_CLASS,
  PARAGRAPH_CLASS,
  QUIZ_EXPLANATION_CLASS,
  QUIZ_REVIEW_PROMPT_CLASS,
  QUIZ_REVIEW_QUESTION_CLASS,
  STUDY_BLOCK_LIST_CLASS,
  TABLE_CLASS,
  TABLE_WRAP_CLASS,
  TD_CLASS,
  TH_CLASS,
  TOC_BOX_CLASS,
  TOC_EMPTY_CLASS,
  TOC_ITEM_CLASS,
  TOC_TITLE_CLASS,
  tocItemIndent,
  UL_CLASS,
} from '@/features/notes/nodeStyles';
import {
  CALLOUT_VARIANT_CLASS,
  type CalloutVariant,
  getCodeBlockLanguageLabel,
  normalizeCalloutVariant,
} from '@/features/notes/richBlockConfig';
import { answerKey } from '@/features/quizzes/grade';
import {
  QuestionRunner,
  QuizOptionView,
} from '@/features/quizzes/QuestionRunner';
import {
  type QuizOptionRole,
  quizOptionClassName,
} from '@/features/quizzes/quizOptionStyles';
import { cn } from '@/lib/cn';
import type {
  FlashcardElement as FlashcardNode,
  MermaidElement as MermaidNode,
  QuizOptionElement as QuizOptionNode,
  QuizQuestionElement as QuizQuestionNode,
} from './document';
import { quizQuestionElementToQuestion } from './document';
import { Katex } from './Katex';
import { type MediaAssetNode, MediaAssetView } from './MediaAssetView';
import { Mermaid, mermaidBlockLabel } from './Mermaid';
import { YouTubeEmbed, type YouTubeNode } from './YouTubeEmbed';

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
      <hr className={HR_CLASS} />
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

function CalloutIcon({ variant }: { variant: CalloutVariant }) {
  const className = 'mt-0.5 size-5 shrink-0';
  switch (variant) {
    case 'success':
      return <CircleCheck aria-hidden className={className} />;
    case 'warning':
      return <CircleAlert aria-hidden className={className} />;
    case 'danger':
      return <CircleX aria-hidden className={className} />;
    default:
      return <Info aria-hidden className={className} />;
  }
}

function Callout(props: SlateElementProps) {
  const variant = normalizeCalloutVariant(
    (props.element as { variant?: unknown }).variant
  );
  return (
    <SlateElement
      {...props}
      className={cn(CALLOUT_CLASS, CALLOUT_VARIANT_CLASS[variant])}
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
    <SlateElement {...props}>
      <div className={TOC_BOX_CLASS}>
        <p className={TOC_TITLE_CLASS}>Table of contents</p>
        {headings.length ? (
          <nav className="flex flex-col">
            {headings.map((node, order) => (
              <button
                className={TOC_ITEM_CLASS}
                key={(node.id as string | undefined) ?? order}
                onClick={(event) => scrollToHeading(event, order)}
                style={tocItemIndent(node.type as string)}
                type="button"
              >
                {NodeApi.string(node)}
              </button>
            ))}
          </nav>
        ) : (
          <p className={TOC_EMPTY_CLASS}>No headings in this document.</p>
        )}
      </div>
      {props.children}
    </SlateElement>
  );
}

function Mention(props: SlateElementProps) {
  const value = String((props.element as { value?: string }).value ?? '');
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
        <Katex displayMode tex={tex} />
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
      <Katex displayMode={false} tex={tex} />
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
  return (
    <SlateElement {...props} className="my-3">
      <MediaAssetView element={props.element as unknown as MediaAssetNode} />
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
          <YouTubeEmbed videoId={element.videoId} />
        ) : (
          <p className="rounded-card border border-solid-error/30 p-3 text-sm text-solid-error">
            This YouTube embed is missing a video ID.
          </p>
        )}
      </div>
      {props.children}
    </SlateElement>
  );
}

/* ------------------------------------------------------------- study blocks */

function BlockShell({
  props,
  label,
  children,
}: {
  props: SlateElementProps;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <SlateElement {...props} className={BLOCK_SHELL_CLASS}>
      <div className="mb-1 flex items-center justify-between">
        <span className="t-label text-fg-muted">{label}</span>
      </div>
      {children}
      {props.children}
    </SlateElement>
  );
}

function QuizElement(props: SlateElementProps) {
  return (
    <SlateElement {...props} className={STUDY_BLOCK_LIST_CLASS}>
      {props.children}
    </SlateElement>
  );
}

function FlashcardsElement(props: SlateElementProps) {
  return (
    <SlateElement {...props} className={cn(STUDY_BLOCK_LIST_CLASS, 'gap-2')}>
      {props.children}
    </SlateElement>
  );
}

function MermaidElement(props: SlateElementProps) {
  const element = props.element as unknown as MermaidNode;
  return (
    <BlockShell label={mermaidBlockLabel(element.source)} props={props}>
      <Mermaid code={element.source} />
    </BlockShell>
  );
}

function QuizQuestionElement(props: SlateElementProps) {
  const element = props.element as unknown as QuizQuestionNode;
  const path = (props as { path?: Path }).path;
  const pathIndex = path?.[path.length - 1];
  const questionNumber =
    typeof pathIndex === 'number' ? pathIndex + 1 : undefined;
  const question = quizQuestionElementToQuestion(element);
  return (
    <SlateElement {...props} className={QUIZ_REVIEW_QUESTION_CLASS}>
      <QuestionRunner
        answer={answerKey(question)}
        onChange={() => undefined}
        question={question}
        questionNumber={questionNumber}
        review
        showExplanation
      />
    </SlateElement>
  );
}

function QuizPromptElement(props: SlateElementProps) {
  return (
    <SlateElement {...props} as="p" className={QUIZ_REVIEW_PROMPT_CLASS}>
      {props.children}
    </SlateElement>
  );
}

function QuizOptionElement(props: SlateElementProps) {
  const element = props.element as unknown as QuizOptionNode & {
    explanation?: string;
    role?: QuizOptionRole;
  };
  const path = (props as { path?: Path }).path;
  const parent = path?.length
    ? NodeApi.get(props.editor, path.slice(0, -1))
    : undefined;
  const question =
    parent?.type === 'quiz_question' ? (parent as QuizQuestionNode) : undefined;
  const correct = question?.correctOptionIds?.includes(element.id);
  const pathIndex = path?.[path.length - 1];
  const optionNumber = typeof pathIndex === 'number' ? pathIndex : undefined;

  return (
    <SlateElement
      {...props}
      className={quizOptionClassName(Boolean(correct), element.role)}
    >
      <QuizOptionView
        correct={Boolean(correct)}
        explanation={element.explanation}
        optionNumber={optionNumber}
        role={element.role}
      >
        {props.children}
      </QuizOptionView>
    </SlateElement>
  );
}

function QuizExplanationElement(props: SlateElementProps) {
  return (
    <SlateElement
      {...props}
      as="p"
      className={cn('col-span-2', QUIZ_EXPLANATION_CLASS)}
    >
      {props.children}
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
  code: mark('code', CODE_MARK_CLASS),
  code_block: CodeBlock,
  code_line: element(undefined),
  code_syntax: CodeSyntax,
  column: Column,
  column_group: element('div', COLUMN_GROUP_CLASS),
  equation: BlockEquation,
  file: MediaAssetElement,
  flashcard: FlashcardElement,
  flashcard_back: element('p', FLASHCARD_BACK_CLASS),
  flashcard_front: element('p', FLASHCARD_FRONT_CLASS),
  flashcards: FlashcardsElement,
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
  mention: Mention,
  mermaid: MermaidElement,
  mermaid_caption: element('p', MERMAID_CAPTION_CLASS),
  ol: element('ol', OL_CLASS),
  // Match editable Paragraph: default to div so indent-list belowNodes can
  // inject <ol>/<div> without nesting block elements inside <p>.
  p: element('div', PARAGRAPH_CLASS),
  /* study blocks */
  quiz: QuizElement,
  quiz_explanation: QuizExplanationElement,
  quiz_option: QuizOptionElement,
  quiz_prompt: QuizPromptElement,
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
