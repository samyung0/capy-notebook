import { createContext, type ReactNode, useContext } from 'react';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { Icon } from '@/components/ui/Icon';
import { useResolvedAsset } from '@/features/materials/MediaAssetView';
import {
  CALLOUT_VARIANT_CLASS,
  type CalloutVariant,
} from '@/features/notes/richBlockConfig';
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

/** Overrides where a quiz image loads from: signed-out pages use the site
 * Worker's share route, and the quiz editor shows images picked but not yet
 * uploaded. Undefined falls back to the authenticated resolve endpoint. */
export const AssetUrlContext = createContext<
  ((assetId: string) => string | undefined) | null
>(null);

/** Quiz images are private editor assets; the signed URL is resolved per render. */
function AssetFigure({
  assetId,
  block,
}: {
  assetId: string;
  block: ImageBlock | GraphBlock;
}) {
  const src = useContext(AssetUrlContext)?.(assetId);
  return src ? (
    <Figure block={block} src={src} />
  ) : (
    <ResolvedAssetFigure assetId={assetId} block={block} />
  );
}

function ResolvedAssetFigure({
  assetId,
  block,
}: {
  assetId: string;
  block: ImageBlock | GraphBlock;
}) {
  const [asset] = useResolvedAsset(assetId);
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
        alt={block.description}
        className={cn(
          'h-auto max-w-full',
          block.type === 'graph' && 'bg-white'
        )}
        height={block.height}
        src={src}
        width={block.width}
      />
      {block.attribution && (
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
  if (answer.type === 'mcq' || answer.type === 'multi')
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

/** Option label column: a dotted letter or number (A., 1.), or a result icon. */
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
        'grid size-6 shrink-0 place-items-center font-bold text-[13px] text-fg-secondary tabular-nums leading-none',
        className
      )}
    >
      {children}
    </span>
  );
}

/** Answer item: a fully rounded bordered row. tip marks a selection;
 * success/danger/warning a result, tinted like editor callouts. Row content
 * keeps `text-fg` itself. */
export function answerRowClass(variant?: CalloutVariant) {
  return cn(
    'flex min-h-11 items-center gap-3 rounded-input border px-3.5 py-2',
    variant ? CALLOUT_VARIANT_CLASS[variant] : 'border-line'
  );
}

/** Matching items above the lettered options on phones, side by side from md. */
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
    <div
      className={cn(
        'grid gap-4.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-6',
        className
      )}
    >
      {items}
      <ol className="grid content-start gap-2 md:pt-2.5">
        {options.map((text, i) => (
          <li className="flex items-baseline gap-3" key={i}>
            <OptionKey className="h-auto">{optionLetter(i)}.</OptionKey>
            <TextView className="min-w-0" text={text} />
          </li>
        ))}
      </ol>
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
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <div className="@container col-[2/-1] min-w-0">
        <ol className={cn('grid gap-2', twoColumns && '@xl:grid-cols-2')}>
          {answer.options.map((text, i) => (
            <li className={answerRowClass()} key={i}>
              <OptionKey>{optionLetter(i)}.</OptionKey>
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
                <OptionKey>{i + 1}.</OptionKey>
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
      <ol className="col-[2/-1] grid min-w-0 gap-2">
        {answer.items.map((text, i) => (
          <li className={answerRowClass()} key={i}>
            <OptionKey>{i + 1}.</OptionKey>
            <TextView className="min-w-0 flex-1" text={text} />
          </li>
        ))}
      </ol>
    );
  return null;
}

export interface QuestionViewProps {
  question: Question | LearnerQuestion;
  questionNumber?: number;
  /** Returns grid items for the part row; an answer spans `col-[2/-1]`. */
  renderAnswer?: (part: QuestionPart | LearnerPart) => ReactNode;
  renderBlock?: (
    block: QuestionBlock,
    index: number,
    section: BlockSection
  ) => ReactNode;
  renderMarks?: (part: QuestionPart | LearnerPart) => ReactNode;
  review?: boolean;
  showTotalMarks?: boolean;
}

export function QuestionView({
  question,
  questionNumber,
  review = false,
  showTotalMarks = true,
  renderAnswer,
  renderBlock,
  renderMarks,
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
  // 1A: number, part label and text share one column grid so every text line
  // starts at the same x; marks stay smaller than the question text. Phones
  // use the tighter B′ columns.
  return (
    <article className="min-w-0 space-y-4 text-[15px] leading-relaxed">
      <header className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-1.5 md:grid-cols-[1.75rem_minmax(0,1fr)_auto] md:gap-x-2">
        <span className="font-bold">
          {questionNumber != null && `${questionNumber}.`}
        </span>
        <div className="min-w-0">
          {firstInHeader &&
            blocks(
              lead.slice(0, 1),
              merged ? { partId: question.parts[0].id } : {}
            )}
        </div>
        {lone && renderMarks ? (
          <span className="whitespace-nowrap text-fg-muted text-xs">
            {renderMarks(question.parts[0])}
          </span>
        ) : (
          showTotalMarks && (
            <span className="whitespace-nowrap text-fg-muted text-xs">
              {total === 1
                ? m.question_ui_one_mark()
                : m.question_ui_marks({ count: total })}
            </span>
          )
        )}
      </header>
      <div
        className={cn(
          'grid min-w-0 gap-6',
          question.layout === 'split' && 'md:grid-cols-2 md:gap-8'
        )}
      >
        {question.stem.length > Number(firstInHeader) && (
          <div
            className={cn(
              'min-w-0 space-y-4',
              question.layout === 'paper' && 'pl-7.5 md:pl-9'
            )}
          >
            {blocks(
              question.stem.slice(Number(firstInHeader)),
              {},
              Number(firstInHeader)
            )}
          </div>
        )}
        <ol className="min-w-0 space-y-6">
          {question.parts.map((part, index) => (
            <li
              className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-1.5 gap-y-3 md:grid-cols-[1.75rem_minmax(0,1fr)_auto] md:gap-x-2"
              key={part.id}
            >
              <span className="font-bold">
                {!lone &&
                  (question.labels === 'letters'
                    ? `(${String.fromCharCode(97 + index)})`
                    : `${index + 1}.`)}
              </span>
              {partBlocks(part).length > 0 && (
                <div className="min-w-0 space-y-3">
                  {blocks(partBlocks(part), { partId: part.id }, partOffset)}
                </div>
              )}
              {!lone && (
                <span className="col-start-3 whitespace-nowrap pt-1 text-fg-muted text-xs">
                  {renderMarks ? renderMarks(part) : `[${part.marks}]`}
                </span>
              )}
              {renderAnswer ? (
                renderAnswer(part)
              ) : (
                <Choices part={part} twoColumns={optionColumns(question)} />
              )}
              {review && isAuthoredPart(part) && (
                <div className="col-start-2 min-w-0 space-y-1 text-fg-secondary text-sm">
                  <h4 className="font-semibold text-fg-muted text-xs">
                    {m.question_ui_answer()}
                  </h4>
                  <div>
                    <AnswerView part={part} />
                  </div>
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
                            <span className="shrink-0 text-fg-muted text-xs tabular-nums">
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
}: Omit<QuestionViewProps, 'question' | 'review'> & { question: Question }) {
  return (
    <QuestionView
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
                          <span className="shrink-0 text-fg-muted text-xs tabular-nums">
                            [{item.marks}]
                          </span>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex shrink-0 items-center gap-1 font-semibold text-xs tabular-nums',
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
              'font-semibold tabular-nums',
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
