import type { ReactNode } from 'react';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { PlotChart } from '@/components/charts/PlotChart';
import { Icon } from '@/components/ui/Icon';
import {
  RemovedMedia,
  useResolvedAsset,
} from '@/features/materials/MediaAssetView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TextView } from './TextView';

export { TextView } from './TextView';

import {
  type GraphBlock,
  type ImageBlock,
  isAuthoredPart,
  type LearnerPart,
  type LearnerQuestion,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  questionMarks,
} from './types';

export type BlockSection = { partId?: string; solution?: boolean };

// Accepted answers are often bare LaTeX such as `-2\sqrt{5}`.
const LATEX_COMMAND = /\\[a-zA-Z]/;

export function QuestionBlockView({ block }: { block: QuestionBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="leading-relaxed">
          {block.label && <strong className="mr-3">{block.label}</strong>}
          <TextView text={block.text} />
        </div>
      );
    case 'chart':
      return <CategoryChart data={block} />;
    case 'plot':
      return <PlotChart data={block} />;
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            {block.header && (
              <thead>
                <tr>
                  {block.rows[0]?.map((cell, i) => (
                    <th
                      className="border border-line bg-surface-hover-bg px-3 py-2 text-left"
                      key={i}
                    >
                      <TextView text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.slice(block.header ? 1 : 0).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="border border-line px-3 py-2" key={j}>
                      <TextView text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'graph':
    case 'image':
      if ('assetId' in block.image)
        return <AssetFigure assetId={block.image.assetId} block={block} />;
      return (
        <Figure
          block={block}
          src={
            'url' in block.image
              ? block.image.url
              : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.image.svg)}`
          }
        />
      );
  }
}

/** Quiz images are private editor assets; the signed URL is resolved per
 * render, or comes from AssetUrlContext on shared pages and in the editor. */
function AssetFigure({
  assetId,
  block,
}: {
  assetId: string;
  block: ImageBlock | GraphBlock;
}) {
  const [asset] = useResolvedAsset(assetId);
  if (asset.status === 'error' && asset.kind === 'removed')
    return <RemovedMedia className="mx-auto w-fit max-w-full" />;
  return (
    <Figure
      block={block}
      src={asset.status === 'ready' ? asset.url : undefined}
    />
  );
}

function Figure({
  block,
  src,
}: {
  block: ImageBlock | GraphBlock;
  src: string | undefined;
}) {
  return (
    <figure className="mx-auto w-fit max-w-full">
      <img
        alt={block.description ?? ''}
        className={cn(
          'h-auto max-w-full',
          block.type === 'graph' && 'bg-white'
        )}
        height={block.height}
        src={src}
        width={block.width}
      />
      {block.type === 'image' && block.attribution && (
        <figcaption className="mt-1 text-fg-muted text-xs">
          {block.attribution}
        </figcaption>
      )}
    </figure>
  );
}
export const BlockView = QuestionBlockView;

export function AnswerView({ part }: { part: QuestionPart }) {
  const answer = part.answer;
  if (answer.type === 'boolean')
    return (
      <span>
        {answer.correct ? m.question_ui_true() : m.question_ui_false()}
      </span>
    );
  if (answer.type === 'mcq')
    return (
      <ol className="grid gap-1">
        {[...answer.correct]
          .sort((a, b) => a - b)
          .map((i) => (
            <li className="flex gap-3" key={i}>
              <span className="text-fg-muted">
                {String.fromCharCode(65 + i)}.
              </span>
              <TextView text={answer.options[i] ?? ''} />
            </li>
          ))}
      </ol>
    );
  if (answer.type === 'short' || answer.type === 'open') {
    const unit =
      answer.type === 'short' && answer.unit
        ? answer.unit === '°'
          ? '°'
          : ` ${answer.unit}`
        : '';
    // Every accepted answer carries its unit.
    return (
      <TextView
        text={answer.accepted
          .map(
            (text) =>
              (!text.includes('$') && LATEX_COMMAND.test(text)
                ? `$${text}$`
                : text) + unit
          )
          .join('; ')}
      />
    );
  }
  if (answer.type === 'gaps')
    return (
      <ol className="grid gap-1">
        {answer.accepted.map((accepted, i) => (
          <li className="flex gap-3" key={i}>
            <span className="text-fg-muted">({i + 1})</span>
            <TextView text={accepted.join(' / ')} />
          </li>
        ))}
      </ol>
    );
  if (answer.type === 'ordering')
    return (
      <ol className="list-inside list-decimal">
        {answer.items.map((item, i) => (
          <li key={i}>
            <TextView text={item} />
          </li>
        ))}
      </ol>
    );
  if (answer.type === 'matching')
    return (
      <ul>
        {answer.pairs.map((pair, i) => (
          <li key={i}>
            <TextView text={pair.left} /> →{' '}
            <TextView text={answer.options[pair.right] ?? ''} />
          </li>
        ))}
      </ul>
    );
}

export const optionLetter = (index: number) => String.fromCharCode(65 + index);

/** Paper questions set options two by two (A B / C D) once the answer area is
 * wide enough; split questions keep one column beside their passage. */
export const optionColumns = (question: Question | LearnerQuestion) =>
  question.layout === 'paper';

/** Option label column: a letter or number in a small square badge, filled
 * when chosen, or a result icon. */
export function OptionKey({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        'grid size-5.5 shrink-0 place-items-center rounded-md font-bold text-[0.8rem] text-fg-muted leading-none',
        className
      )}
    >
      {children}
    </span>
  );
}

/** How an answer row reads: chosen while answering, then right, wrong or the
 * correct answer the learner missed once checked. */
export type RowState = 'selected' | 'right' | 'wrong' | 'missed';

/** A checked answer's soft green or red fill and text, see-through on a
 * frosted panel so the frost shows under it. */
export function reviewTintClass(right: boolean) {
  return right
    ? 'bg-tint-success frosted:bg-tint-success/60 text-tint-success-fg'
    : 'bg-tint-error frosted:bg-tint-error/60 text-tint-error-fg';
}

/** Answer item: a row over one bottom rule instead of a box. Choosing one
 * thickens and colours the rule; once checked, right, wrong and missed rows
 * turn to a tinted block reaching a little past the text on each side. The
 * row's height stays put. */
export function answerRowClass(state?: RowState) {
  const checked = state === 'right' || state === 'wrong' || state === 'missed';
  return cn(
    'flex min-h-11 items-center gap-3 border-b px-0.5 py-2',
    state ? 'border-b-2 pb-[7px]' : 'border-line',
    state === 'selected' && 'border-solid-accent-1 text-tint-accent-1-fg',
    checked && '-mx-2 rounded-lg border-transparent px-2.5',
    checked && reviewTintClass(state !== 'wrong')
  );
}

/** A key badge's colours for a row state: filled when chosen or checked. */
export function optionKeyClass(state?: RowState) {
  return cn(
    state === 'selected' && 'bg-solid-accent-1 text-surface',
    (state === 'right' || state === 'missed') &&
      'bg-tint-success-fg text-surface',
    state === 'wrong' && 'bg-tint-error-fg text-surface'
  );
}

/** Lettered options above the matching items, side by side once the answer
 * area is 50rem wide. */
export function MatchingLayout({
  className,
  items,
  options,
}: {
  className?: string;
  items: ReactNode;
  options: string[];
}) {
  return (
    <div className={cn('@container', className)}>
      <div className="grid @min-[50rem]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @min-[50rem]:gap-6 gap-4.5">
        {items}
        <ol className="@min-[50rem]:order-none order-first grid content-start gap-2 @min-[50rem]:pt-2.5">
          {options.map((text, i) => (
            <li className="flex items-baseline gap-3" key={i}>
              <OptionKey className="h-auto">{optionLetter(i)}</OptionKey>
              <TextView className="min-w-0" text={text} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// Answer areas span the text and marks columns of a part row.
function Choices({
  part,
  twoColumns,
}: {
  part: QuestionPart | LearnerPart;
  twoColumns: boolean;
}) {
  const answer = part.answer;
  if (answer.type === 'mcq')
    return (
      <div className="@container col-[2/-1] min-w-0">
        <ol className={cn('grid', twoColumns && '@xl:grid-cols-2 @xl:gap-x-7')}>
          {answer.options.map((text, i) => (
            <li className={answerRowClass()} key={i}>
              <OptionKey>{optionLetter(i)}</OptionKey>
              <TextView className="min-w-0 flex-1" text={text} />
            </li>
          ))}
        </ol>
      </div>
    );
  if (answer.type === 'matching')
    return (
      <MatchingLayout
        className="col-[2/-1] min-w-0"
        items={
          <ol className="grid content-start gap-2">
            {('left' in answer
              ? answer.left
              : answer.pairs.map((pair) => pair.left)
            ).map((text, i) => (
              <li className="flex min-h-11 items-center gap-3" key={i}>
                <OptionKey>{i + 1}</OptionKey>
                <TextView className="min-w-0" text={text} />
              </li>
            ))}
          </ol>
        }
        options={answer.options}
      />
    );
  if (answer.type === 'ordering')
    return (
      <ol className="col-[2/-1] grid min-w-0">
        {answer.items.map((text, i) => (
          <li className={answerRowClass()} key={i}>
            <OptionKey>{i + 1}</OptionKey>
            <TextView className="min-w-0 flex-1" text={text} />
          </li>
        ))}
      </ol>
    );
  return null;
}

/** A number or part label. Each stacks the question's other labels unseen,
 * so the label column is as wide as the widest and every text beside one
 * starts at the same x; no labels at all leave the column (and gap) empty. */
function Label({ all, text }: { all: string[]; text: string }) {
  if (all.length === 0) return <span />;
  return (
    <span className="grid pr-2.5 font-bold md:pr-3">
      {all.map((item) => (
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1"
          key={item}
        >
          {item}
        </span>
      ))}
      <span className="col-start-1 row-start-1">{text}</span>
    </span>
  );
}

export interface QuestionViewProps {
  /** False where the question's marks already show beside it, as in a
   * review result's row; parts keep theirs. */
  headerMarks?: boolean;
  question: Question | LearnerQuestion;
  questionNumber?: number;
  /** Returns grid items for the part row; an answer spans `col-[2/-1]`. */
  renderAnswer?: (part: QuestionPart | LearnerPart) => ReactNode;
  /** A block as the caller draws it; `view` is the block as drawn here
   * when it differs from a plain view (a gaps part's text with its fields). */
  renderBlock?: (
    block: QuestionBlock,
    index: number,
    section: BlockSection,
    view?: ReactNode
  ) => ReactNode;
  renderMarks?: (part: QuestionPart | LearnerPart) => ReactNode;
  review?: boolean;
  showTotalMarks?: boolean;
  /** Right of a title, after its marks: the question's (no part id) or a
   * part's (several parts); the question dialog's issue icons. */
  titleAside?: (partId?: string) => ReactNode;
}

export function QuestionView({
  question,
  questionNumber,
  review = false,
  showTotalMarks = true,
  headerMarks = true,
  renderAnswer,
  renderBlock,
  renderMarks,
  titleAside,
}: QuestionViewProps) {
  // A lone part needs no label, and the header's marks stand in for its own.
  // With no stem either, its first text block joins the header.
  const lone = question.parts.length === 1;
  const merged = lone && question.stem.length === 0;
  const lead = merged ? question.parts[0].blocks : question.stem;
  const firstInHeader =
    (merged || question.layout === 'paper') && lead[0]?.type === 'text';
  const partOffset = Number(merged && firstInHeader);
  const total = questionMarks(question);
  const blocks = (items: QuestionBlock[], section: BlockSection, offset = 0) =>
    items.map((block, i) => (
      <div key={i}>
        {renderBlock ? (
          renderBlock(block, i + offset, section)
        ) : (
          <QuestionBlockView block={block} />
        )}
      </div>
    ));
  const partBlocks = (part: QuestionPart | LearnerPart) =>
    part.blocks.slice(partOffset);
  const partLabel = (index: number) =>
    question.labels === 'letters'
      ? `(${String.fromCharCode(97 + index)})`
      : `${index + 1}.`;
  const labels = [
    ...new Set([
      ...(questionNumber == null ? [] : [`${questionNumber}.`]),
      ...(lone ? [] : question.parts.map((_, index) => partLabel(index))),
    ]),
  ];
  const label = (text: string) => <Label all={labels} text={text} />;
  // 1A: number, part label and text share one column grid so every text line
  // starts at the same x; marks stay smaller than the question text. The
  // label column is as wide as the question's widest label. Below 36rem of
  // the question's own width (phones, the Study panel) every layout reads as
  // split does: number and marks on the top row, the stem full width under.
  return (
    <article className="@container/question min-w-0 space-y-4 text-[15px] leading-relaxed">
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline">
        {label(questionNumber == null ? '' : `${questionNumber}.`)}
        <div
          className={cn(
            'min-w-0',
            firstInHeader &&
              '@max-[36rem]/question:col-span-full @max-[36rem]/question:row-start-2 @max-[36rem]/question:pt-4'
          )}
        >
          {firstInHeader &&
            blocks(
              lead.slice(0, 1),
              merged ? { partId: question.parts[0].id } : {}
            )}
        </div>
        <span className="@max-[36rem]/question:col-start-3 @max-[36rem]/question:row-start-1 flex items-center gap-1 whitespace-nowrap pl-1.5 text-fg-muted text-sm md:pl-2">
          {headerMarks &&
            (lone && renderMarks
              ? renderMarks(question.parts[0])
              : showTotalMarks &&
                (total === 1
                  ? m.question_ui_one_mark()
                  : m.question_ui_marks({ count: total })))}
          {titleAside?.()}
        </span>
      </header>
      <div
        className={cn(
          'grid min-w-0 gap-6',
          // By the question's own width, so it stacks in the Study panel.
          question.layout === 'split' &&
            '@min-[36rem]/question:grid-cols-2 @min-[36rem]/question:gap-8'
        )}
      >
        {question.stem.length > Number(firstInHeader) && (
          <div
            className={cn(
              'min-w-0',
              question.layout === 'paper' &&
                'grid @max-[36rem]/question:grid-cols-1 grid-cols-[auto_minmax(0,1fr)]'
            )}
          >
            {question.layout === 'paper' && (
              <span className="@max-[36rem]/question:hidden">{label('')}</span>
            )}
            <div className="min-w-0 space-y-4">
              {blocks(
                question.stem.slice(Number(firstInHeader)),
                {},
                Number(firstInHeader)
              )}
            </div>
          </div>
        )}
        <ol className="min-w-0 space-y-6">
          {question.parts.map((part, index) => (
            <li
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)_auto] gap-y-3',
                // A lone part has no label: on narrow widths its empty column
                // closes so the part lines up with the stem.
                lone && '@max-[36rem]/question:grid-cols-[0_minmax(0,1fr)_auto]'
              )}
              key={part.id}
            >
              {lone ? (
                <span className="overflow-hidden">{label('')}</span>
              ) : (
                label(partLabel(index))
              )}
              {partBlocks(part).length > 0 && (
                <div className="min-w-0 space-y-3">
                  {blocks(partBlocks(part), { partId: part.id }, partOffset)}
                </div>
              )}
              {!lone && (
                <span className="col-start-3 flex items-start gap-1 whitespace-nowrap pt-1 pl-1.5 text-fg-muted text-sm md:pl-2">
                  {renderMarks ? renderMarks(part) : `[${part.marks}]`}
                  {titleAside?.(part.id)}
                </span>
              )}
              {renderAnswer ? (
                renderAnswer(part)
              ) : (
                <Choices part={part} twoColumns={optionColumns(question)} />
              )}
              {review && isAuthoredPart(part) && (
                <div className="col-start-2 min-w-0 space-y-1 text-fg-secondary text-sm">
                  {/* An open part's sample answer is optional. */}
                  {(part.answer.type !== 'open' ||
                    part.answer.accepted.length > 0) && (
                    <>
                      <h4 className="font-semibold text-fg-muted text-xs">
                        {m.question_ui_answer()}
                      </h4>
                      <div>
                        <AnswerView part={part} />
                      </div>
                    </>
                  )}
                  {part.markscheme && (
                    <>
                      <h4 className="pt-2 font-semibold text-fg-muted text-xs">
                        {m.question_ui_marking_scheme()}
                      </h4>
                      <ul className="space-y-1">
                        {part.markscheme.map((item, i) => (
                          <li className="flex items-baseline gap-4" key={i}>
                            <TextView
                              className="min-w-0 flex-1"
                              text={item.text}
                            />
                            <span className="shrink-0 text-fg-muted text-sm">
                              [{item.marks}]
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {part.solution.length > 0 && (
                    // Editors check solutions, so they start open here;
                    // learners' after-submit review keeps them collapsed.
                    <details open>
                      <summary className="cursor-pointer pt-2 font-semibold">
                        {m.question_ui_worked_solution()}
                      </summary>
                      <div className="mt-2 space-y-3">
                        {blocks(part.solution, {
                          partId: part.id,
                          solution: true,
                        })}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

export function QuestionReview({
  question,
  renderAnswer,
  renderBlock,
  questionNumber,
  headerMarks,
}: Omit<QuestionViewProps, 'question' | 'review'> & { question: Question }) {
  return (
    <QuestionView
      headerMarks={headerMarks}
      question={question}
      questionNumber={questionNumber}
      renderAnswer={(part) => {
        if (!isAuthoredPart(part)) return null;
        // Closed parts have no scheme: their answer key and solution explain them.
        const items = part.markscheme ?? [];
        if (items.length === 0 && part.solution.length === 0)
          return renderAnswer?.(part);
        return (
          <>
            {renderAnswer?.(part)}
            <details className="col-start-2 min-w-0 text-sm">
              <summary className="cursor-pointer font-semibold text-fg-secondary">
                {items.length === 0
                  ? m.question_ui_worked_solution()
                  : part.solution.length > 0
                    ? m.question_ui_scheme_and_solution()
                    : m.question_ui_marking_scheme()}
              </summary>
              <div className="grid gap-3 pt-3 text-fg-secondary">
                <ul className="space-y-1 empty:hidden">
                  {items.map((item, i) => {
                    // Jev's marks per item, once the open part is graded.
                    const award = part.itemAwards?.[i];
                    return (
                      <li className="flex items-baseline gap-4" key={i}>
                        <TextView className="min-w-0 flex-1" text={item.text} />
                        {award == null ? (
                          <span className="shrink-0 text-fg-muted text-sm">
                            [{item.marks}]
                          </span>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex shrink-0 items-center gap-1 font-semibold text-sm',
                              award === item.marks
                                ? 'text-tint-success-fg'
                                : award > 0
                                  ? 'text-tint-warning-fg'
                                  : 'text-tint-error-fg'
                            )}
                          >
                            <Icon
                              name={
                                award === item.marks
                                  ? 'check'
                                  : award > 0
                                    ? 'minus'
                                    : 'x'
                              }
                              size={12}
                            />
                            {award} / {item.marks}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {part.solution.map((block, i) => (
                  <QuestionBlockView block={block} key={i} />
                ))}
              </div>
            </details>
          </>
        );
      }}
      renderBlock={renderBlock}
      renderMarks={(part) => {
        const awarded = 'awarded' in part ? part.awarded : undefined;
        const max = part.marks;
        return (
          <span
            className={cn(
              'font-bold',
              awarded == null
                ? 'text-fg-muted'
                : awarded === max
                  ? 'text-tint-success-fg'
                  : awarded > 0
                    ? 'text-tint-warning-fg'
                    : 'text-tint-error-fg'
            )}
          >
            {awarded ?? '—'} / {max}
          </span>
        );
      }}
      showTotalMarks={false}
    />
  );
}
