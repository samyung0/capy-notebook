import type { ReactNode } from 'react';
import { CategoryChart } from '@/components/charts/CategoryChart';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TextView } from './TextView';

export { TextView } from './TextView';

import {
  type LearnerPart,
  type LearnerQuestion,
  partMarks,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  questionMarks,
} from './types';

export type BlockSection = { partId?: string; solution?: boolean };

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
    case 'image': {
      const src =
        block.type === 'image'
          ? block.url
          : 'url' in block.image
            ? block.image.url
            : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.image.svg)}`;
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
  }
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
      <TextView
        text={answer.correct.map((i) => answer.options[i]).join('; ')}
      />
    );
  if (answer.type === 'short' || answer.type === 'open')
    return (
      <TextView
        text={
          answer.accepted.join('; ') +
          (answer.type === 'short' && answer.unit ? ` ${answer.unit}` : '')
        }
      />
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

function Choices({ part }: { part: QuestionPart | LearnerPart }) {
  const answer = part.answer;
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <ol className="mt-3 grid gap-2">
        {answer.options.map((text, i) => (
          <li className="flex gap-3" key={i}>
            <span className="text-fg-muted">
              {String.fromCharCode(65 + i)}.
            </span>
            <TextView text={text} />
          </li>
        ))}
      </ol>
    );
  if (answer.type === 'matching')
    return (
      <div className="mt-3 grid grid-cols-2 gap-4">
        <ol>
          {('left' in answer
            ? answer.left
            : answer.pairs.map((pair) => pair.left)
          ).map((text, i) => (
            <li key={i}>
              <TextView text={text} />
            </li>
          ))}
        </ol>
        <ol>
          {answer.options.map((text, i) => (
            <li key={i}>
              {String.fromCharCode(65 + i)}. <TextView text={text} />
            </li>
          ))}
        </ol>
      </div>
    );
  if (answer.type === 'ordering')
    return (
      <ul className="mt-3">
        {answer.items.map((text, i) => (
          <li key={i}>
            <TextView text={text} />
          </li>
        ))}
      </ul>
    );
  return null;
}

export interface QuestionViewProps {
  question: Question | LearnerQuestion;
  questionNumber?: number;
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
  const firstInHeader =
    question.layout === 'paper' && question.stem[0]?.type === 'text';
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
  // 1A: number, part label and text share one column grid so every text line
  // starts at the same x; marks stay smaller than the question text.
  return (
    <article className="min-w-0 space-y-4 text-[15px] leading-relaxed">
      <header className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2">
        <span className="font-bold">
          {questionNumber != null && `${questionNumber}.`}
        </span>
        <div className="min-w-0">
          {firstInHeader && blocks(question.stem.slice(0, 1), {})}
        </div>
        {showTotalMarks && (
          <span className="whitespace-nowrap text-fg-muted text-xs">
            {questionMarks(question) === 1
              ? m.question_ui_one_mark()
              : m.question_ui_marks({ count: questionMarks(question) })}
          </span>
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
              question.layout === 'paper' && 'pl-9'
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
              className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-2"
              key={part.id}
            >
              <span className="font-bold">
                {question.labels === 'letters'
                  ? `(${String.fromCharCode(97 + index)})`
                  : `${index + 1}.`}
              </span>
              <div className="min-w-0 space-y-3">
                {blocks(part.blocks, { partId: part.id })}
                {renderAnswer ? renderAnswer(part) : <Choices part={part} />}
                {review && 'markscheme' in part && (
                  <div className="space-y-1 text-fg-secondary text-sm">
                    <h4 className="font-semibold text-fg-muted text-xs">
                      {m.question_ui_answer()}
                    </h4>
                    <div>
                      <AnswerView part={part} />
                    </div>
                    <h4 className="pt-2 font-semibold text-fg-muted text-xs">
                      {m.question_ui_marking_scheme()}
                    </h4>
                    <ul className="space-y-1">
                      {part.markscheme.map((item, i) => (
                        <li key={i}>
                          <TextView text={item} />
                        </li>
                      ))}
                    </ul>
                    {part.solution.length > 0 && (
                      <details>
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
              </div>
              <span className="whitespace-nowrap pt-1 text-fg-muted text-xs">
                {renderMarks ? renderMarks(part) : `[${partMarks(part)}]`}
              </span>
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
  questionNumber,
}: Omit<QuestionViewProps, 'question' | 'review'> & { question: Question }) {
  return (
    <QuestionView
      question={question}
      questionNumber={questionNumber}
      renderAnswer={(part) =>
        'markscheme' in part ? (
          <div className="space-y-1">
            <h4 className="font-semibold text-fg-muted text-xs">
              {m.question_ui_marking_scheme()}
            </h4>
            <ul className="space-y-1 text-sm">
              {part.markscheme.map((item, i) => (
                <li className="flex items-baseline gap-4" key={i}>
                  <TextView className="min-w-0 flex-1" text={item} />
                  {part.answer.type !== 'open' && part.awarded != null && (
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 font-semibold text-xs tabular-nums',
                        part.awarded === partMarks(part)
                          ? 'text-solid-success'
                          : 'text-solid-error'
                      )}
                    >
                      <Icon
                        name={part.awarded === partMarks(part) ? 'check' : 'x'}
                        size={12}
                      />
                      {part.awarded === partMarks(part) ? '1' : '0'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <h4 className="pt-2 font-semibold text-fg-muted text-xs">
              {m.question_ui_your_answer()}
            </h4>
            {renderAnswer?.(part)}
            {part.awardReason && <p>{part.awardReason}</p>}
            {part.solution.length > 0 && (
              <details>
                <summary className="cursor-pointer pt-2 font-semibold text-fg-secondary text-sm">
                  {m.question_ui_worked_solution()}
                </summary>
                <div className="space-y-3 pt-3">
                  {part.solution.map((block, i) => (
                    <QuestionBlockView block={block} key={i} />
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : null
      }
      renderMarks={(part) => (
        <>
          {'awarded' in part ? (part.awarded ?? '—') : '—'} / {partMarks(part)}
        </>
      )}
      showTotalMarks={false}
    />
  );
}
