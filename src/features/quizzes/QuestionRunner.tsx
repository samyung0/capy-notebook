import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Question, QuestionPart } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input, InputError } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Textarea } from '@/components/ui/TextArea';
import {
  AnswerView,
  answerRowClass,
  MatchingLayout,
  OptionKey,
  optionColumns,
  optionLetter,
  QuestionBlockView,
  QuestionReview,
  QuestionView,
  type QuestionViewProps,
  TextView,
} from '@/features/questions/QuestionView';
import {
  GAP_MARKER,
  isAuthoredPart,
  type LearnerPart,
  type LearnerQuestion,
  type TextBlock,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  type Answer,
  type Answers,
  emptyAnswer,
  quantityValue,
  scoredItems,
  scorePart,
  shuffledIndices,
} from './grade';

const NON_QUANTITY_CHAR = /[^\d\s+\-./eE]/;

/** Whether a learner has given an answer for a part (ordering always has one). */
export function isAnswered(value: Answer | undefined): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  // Gaps start as empty strings, one per gap.
  if (Array.isArray(value))
    return value.some((item) => typeof item === 'number' || item.trim() !== '');
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * One question in the shared quiz look, used for taking, reviewing and every
 * read-only view (quiz preview, quiz editor, question bank, question dialog).
 */
export function QuestionRunner({
  question,
  answers,
  onChange,
  review = false,
  disabled = false,
  showAnswerKey = false,
  questionNumber,
  renderBlock,
}: {
  /** Learner questions (no answer key) only render without `review`. */
  question: Question | LearnerQuestion;
  answers: Answers;
  onChange?: (partId: string, value: Answer) => void;
  review?: boolean;
  /** Read-only preview: the answer controls show but take no input. */
  disabled?: boolean;
  /** Editors: list the answer, marking scheme and worked solution under each part. */
  showAnswerKey?: boolean;
  questionNumber?: number;
  renderBlock?: QuestionViewProps['renderBlock'];
}) {
  // A gaps part's text carries its own fields, one per numbered blank.
  const gapBlock: QuestionViewProps['renderBlock'] = (
    block,
    index,
    section
  ) => {
    const part = question.parts.find(
      (item) => item.id === section.partId && item.answer.type === 'gaps'
    );
    if (part && block.type === 'text' && !section.solution)
      return (
        <GapText
          block={block}
          disabled={disabled}
          onChange={(value) => onChange?.(part.id, value)}
          part={part}
          review={review}
          value={answers[part.id] ?? emptyAnswer(part)}
        />
      );
    return renderBlock ? (
      renderBlock(block, index, section)
    ) : (
      <QuestionBlockView block={block} />
    );
  };
  const answer = (part: QuestionPart | LearnerPart) => (
    <div className="@container col-[2/-1] min-w-0">
      <PartRunner
        disabled={disabled}
        key={part.id}
        onChange={(value) => onChange?.(part.id, value)}
        part={part}
        review={review}
        twoColumns={optionColumns(question)}
        value={answers[part.id] ?? emptyAnswer(part as QuestionPart)}
      />
    </div>
  );
  if (!review)
    return (
      <QuestionView
        question={question}
        questionNumber={questionNumber}
        renderAnswer={answer}
        renderBlock={gapBlock}
        review={showAnswerKey}
      />
    );
  const graded = question as Question;
  return (
    <QuestionReview
      question={{
        ...graded,
        parts: graded.parts.map((part) => ({
          ...part,
          awarded: scorePart(part, answers[part.id]).awarded,
        })),
      }}
      questionNumber={questionNumber}
      renderAnswer={answer}
      renderBlock={gapBlock}
    />
  );
}

/** A gaps part's text with a small field at each "(n) ______" blank; on review
 * each field shows right or wrong, with the accepted answers after a wrong one. */
function GapText({
  block,
  part,
  value,
  onChange,
  review,
  disabled,
}: {
  block: TextBlock;
  part: QuestionPart | LearnerPart;
  value: Answer;
  onChange: (value: Answer) => void;
  review: boolean;
  disabled: boolean;
}) {
  const answer = part.answer;
  if (answer.type !== 'gaps') return null;
  const count = 'gaps' in answer ? answer.gaps : answer.accepted.length;
  const typed = Array.from({ length: count }, (_, i) => {
    const item = Array.isArray(value) ? value[i] : undefined;
    return typeof item === 'string' ? item : '';
  });
  const results =
    review && isAuthoredPart(part) ? scoredItems(part, value) : undefined;
  // split() with a capture group alternates text and blank numbers.
  const pieces = block.text.split(new RegExp(GAP_MARKER.source));
  return (
    <div className="leading-[2.4]">
      {block.label && <strong className="mr-3">{block.label}</strong>}
      {pieces.map((piece, i) => {
        if (i % 2 === 0) return <TextView key={i} text={piece} />;
        const gap = Number(piece) - 1;
        return (
          <span className="whitespace-nowrap" key={i}>
            <Input
              aria-label={m.question_ui_gap({ number: gap + 1 })}
              className="py-0.5 text-center"
              disabled={review || disabled}
              onChange={(event) =>
                onChange(
                  typed.map((item, j) =>
                    j === gap ? event.target.value : item
                  )
                )
              }
              placeholder={String(gap + 1)}
              value={typed[gap] ?? ''}
              wrapperClassName={cn(
                'mx-1 inline-flex w-36 align-middle',
                results &&
                  (results[gap] ? 'border-solid-success' : 'border-solid-error')
              )}
            />
            {results && !results[gap] && 'accepted' in answer && (
              <span className="mr-1 font-bold text-tint-success-fg text-xs">
                {answer.accepted[gap]?.join(' / ')}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** A choice as a bordered row: tip when selected; after checking, success or danger with a tag. */
function ChoiceRow({
  label,
  text,
  selected,
  correct,
  review,
  disabled,
  onClick,
}: {
  label: ReactNode;
  text: ReactNode;
  selected: boolean;
  correct: boolean;
  review: boolean;
  disabled: boolean;
  onClick?: () => void;
}) {
  const result = review && (selected || correct);
  const icon = review && selected;
  return (
    <button
      aria-pressed={selected}
      className={cn(
        answerRowClass(
          review && selected
            ? correct
              ? 'success'
              : 'danger'
            : !review && selected
              ? 'tip'
              : undefined
        ),
        'w-full text-left disabled:cursor-default',
        review && !selected && correct && 'border-solid-success/45',
        !(review || disabled || selected) && 'hover:bg-surface-hover-bg'
      )}
      disabled={review || disabled}
      onClick={onClick}
      type="button"
    >
      <OptionKey
        className={cn(
          !review && selected && 'text-tint-accent-1-fg',
          icon &&
            cn(
              'rounded-full text-surface',
              correct ? 'bg-tint-success-fg' : 'bg-tint-error-fg'
            ),
          review && !selected && correct && 'text-tint-success-fg'
        )}
      >
        {icon ? <Icon name={correct ? 'check' : 'x'} size={13} /> : label}
      </OptionKey>
      <span className="min-w-0 flex-1 text-fg">{text}</span>
      {result && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-bold text-xs',
            correct ? 'text-tint-success-fg' : 'text-tint-error-fg'
          )}
        >
          {selected
            ? m.question_ui_your_answer()
            : m.question_ui_correct_answer()}
        </span>
      )}
    </button>
  );
}

function PartRunner({
  part,
  value,
  onChange,
  review,
  disabled,
  twoColumns,
}: {
  part: QuestionPart | LearnerPart;
  value: Answer;
  onChange: (value: Answer) => void;
  review: boolean;
  disabled: boolean;
  twoColumns: boolean;
}) {
  const answer = part.answer;
  // Learner questions carry no key; only a graded review reads it.
  const key = isAuthoredPart(part) ? part.answer : undefined;
  // Ordering starts shuffled and the shown order is the answer, so it is
  // committed as soon as a learner sees it. Matching letters follow the
  // stored option order.
  // Keyed on the item count so an edited question never keeps a stale index.
  const itemCount = answer.type === 'ordering' ? answer.items.length : 0;
  const order = useMemo(() => shuffledIndices(itemCount), [itemCount]);
  const taking = !(review || disabled);
  useEffect(() => {
    if (taking && answer.type === 'ordering' && value === null) onChange(order);
  }, [taking, answer.type, value, onChange, order]);
  const [unitError, setUnitError] = useState(false);
  // Choice and ordering answers are option indices; gaps are typed strings.
  const indices = Array.isArray(value)
    ? value.filter((item) => typeof item === 'number')
    : null;
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <div className={cn('grid gap-2', twoColumns && '@xl:grid-cols-2')}>
        {answer.options.map((option, i) => {
          const selected = indices?.includes(i) ?? false;
          return (
            <ChoiceRow
              correct={key?.type === answer.type && key.correct.includes(i)}
              disabled={disabled}
              key={i}
              label={`${optionLetter(i)}.`}
              onClick={() =>
                onChange(
                  answer.type === 'mcq'
                    ? [i]
                    : selected
                      ? (indices ?? []).filter((n) => n !== i)
                      : [...(indices ?? []), i]
                )
              }
              review={review}
              selected={selected}
              text={<TextView text={option} />}
            />
          );
        })}
      </div>
    );
  if (answer.type === 'boolean')
    return review ? (
      <div className="grid gap-2">
        {[true, false].map((option) => (
          <ChoiceRow
            correct={key?.type === 'boolean' && key.correct === option}
            disabled
            key={String(option)}
            label={null}
            review
            selected={value === option}
            text={option ? m.question_ui_true() : m.question_ui_false()}
          />
        ))}
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-2">
        {[true, false].map((option) => (
          <button
            aria-pressed={value === option}
            className={cn(
              answerRowClass(value === option ? 'tip' : undefined),
              'justify-center font-semibold disabled:cursor-default',
              value !== option && !disabled && 'hover:bg-surface-hover-bg'
            )}
            disabled={disabled}
            key={String(option)}
            onClick={() => onChange(option)}
            type="button"
          >
            {option ? m.question_ui_true() : m.question_ui_false()}
          </button>
        ))}
      </div>
    );
  // Gap fields sit inside the part's text (GapText), not under it.
  if (answer.type === 'gaps') return null;
  if (answer.type === 'short') {
    const right = 'awarded' in part && part.awarded === part.marks;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Input
              aria-label={m.question_ui_your_answer()}
              disabled={review || disabled}
              onBlur={() =>
                setUnitError(
                  Boolean(
                    answer.unit &&
                      typeof value === 'string' &&
                      value.trim() &&
                      quantityValue(value) === undefined
                  )
                )
              }
              onChange={(event) => {
                const next = event.target.value;
                if (answer.unit && NON_QUANTITY_CHAR.test(next)) {
                  setUnitError(true);
                  return;
                }
                setUnitError(false);
                onChange(next);
              }}
              placeholder={m.question_ui_type_answer()}
              value={typeof value === 'string' ? value : ''}
              wrapperClassName={cn(
                'w-full',
                review &&
                  (right
                    ? 'border-solid-success pr-10'
                    : 'border-solid-error pr-10')
              )}
            />
            {review && (
              <span
                className={cn(
                  'absolute top-1/2 right-3 grid size-5 -translate-y-1/2 place-items-center rounded-full text-surface',
                  right ? 'bg-tint-success-fg' : 'bg-tint-error-fg'
                )}
              >
                <Icon name={right ? 'check' : 'x'} size={12} />
              </span>
            )}
          </div>
          {answer.unit && (
            <span className="shrink-0 text-fg-secondary">{answer.unit}</span>
          )}
        </div>
        {unitError && (
          <InputError>
            {m.question_ui_value_only({ unit: answer.unit })}
          </InputError>
        )}
        {review && isAuthoredPart(part) && (
          <p className="mt-2 text-sm">
            <span className="mr-1.5 font-bold text-tint-success-fg text-xs">
              {m.question_ui_accepted_answers()}
            </span>
            <AnswerView part={part} />
          </p>
        )}
      </div>
    );
  }
  if (answer.type === 'open')
    return (
      <Textarea
        aria-label={m.question_ui_your_answer()}
        disabled={review || disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={m.question_ui_type_answer()}
        value={typeof value === 'string' ? value : ''}
      />
    );
  if (answer.type === 'matching') {
    const choices =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    // Borderless rows: the Select carries the only border.
    const rows = (
      <ol className="grid content-start gap-2">
        {('left' in answer
          ? answer.left
          : answer.pairs.map((pair) => pair.left)
        ).map((left, i) => {
          const chosen = choices[String(i)];
          const right =
            key?.type === 'matching' ? key.pairs[i]?.right : undefined;
          const correct = chosen === right;
          return (
            <li className="flex min-h-11 items-center gap-3" key={i}>
              <OptionKey>{i + 1}.</OptionKey>
              <TextView className="min-w-0 flex-1 text-fg" text={left} />
              {review ? (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-2 whitespace-nowrap font-bold text-xs',
                    correct ? 'text-tint-success-fg' : 'text-tint-error-fg'
                  )}
                >
                  {chosen === undefined ? '–' : optionLetter(chosen)}
                  {!correct && right !== undefined && (
                    <span className="text-tint-success-fg">
                      {m.question_ui_correct_letter({
                        letter: optionLetter(right),
                      })}
                    </span>
                  )}
                </span>
              ) : (
                <div className="w-22 shrink-0">
                  <Select
                    disabled={disabled}
                    onValueChange={(next) =>
                      onChange({ ...choices, [String(i)]: Number(next) })
                    }
                    value={chosen === undefined ? '' : String(chosen)}
                  >
                    <SelectTrigger aria-label={left} size="sm">
                      <SelectValue placeholder="–" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {answer.options.map((option, index) => (
                          <SelectItem
                            hint={<TextView text={option} />}
                            key={index}
                            value={String(index)}
                          >
                            {optionLetter(index)}.
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    );
    // The option list stays after checking so result letters keep their text.
    return <MatchingLayout items={rows} options={answer.options} />;
  }
  if (answer.type === 'ordering') {
    if (review && !indices) return <p>—</p>;
    const current = indices ?? order;
    function move(index: number, direction: number) {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      onChange(next);
    }
    return (
      <div className="grid gap-2">
        {current.map((item, i) => (
          <div
            className={cn(
              answerRowClass(
                review ? (item === i ? 'success' : 'danger') : undefined
              ),
              !review && 'py-1 pr-1.5'
            )}
            key={item}
          >
            <OptionKey
              className={cn(
                review &&
                  (item === i ? 'text-tint-success-fg' : 'text-tint-error-fg')
              )}
            >
              {i + 1}.
            </OptionKey>
            <TextView
              className="min-w-0 flex-1 text-fg"
              text={answer.items[item]}
            />
            {review ? (
              item !== i && (
                <span className="shrink-0 whitespace-nowrap font-bold text-tint-error-fg text-xs">
                  {m.question_ui_should_be({ position: item + 1 })}
                </span>
              )
            ) : (
              <span className="flex shrink-0 items-center">
                <IconButton
                  disabled={disabled || i === 0}
                  icon="chevronUp"
                  label={m.question_ui_move_up()}
                  onClick={() => move(i, -1)}
                  size="sm"
                  variant="ghost-hover"
                />
                <IconButton
                  disabled={disabled || i === current.length - 1}
                  icon="chevronDown"
                  label={m.question_ui_move_down()}
                  onClick={() => move(i, 1)}
                  size="sm"
                  variant="ghost-hover"
                />
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }
  return null;
}
