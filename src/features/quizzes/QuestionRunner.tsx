import { type ReactNode, useState } from 'react';
import type { Question, QuestionPart } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import {
  AnswerView,
  answerRowClass,
  MatchingLayout,
  OptionKey,
  optionLetter,
  QuestionReview,
  QuestionView,
  TextView,
} from '@/features/questions/QuestionView';
import { partMarks } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  type Answer,
  type Answers,
  emptyAnswer,
  quantityValue,
  scorePart,
  shuffledIndices,
} from './grade';

const NON_QUANTITY_CHAR = /[^\d\s+\-./eE]/;

export function QuestionRunner({
  question,
  answers,
  onChange,
  review = false,
  questionNumber,
}: {
  question: Question;
  answers: Answers;
  onChange: (partId: string, value: Answer) => void;
  review?: boolean;
  questionNumber?: number;
}) {
  const View = review ? QuestionReview : QuestionView;
  const displayedQuestion = review
    ? {
        ...question,
        parts: question.parts.map((part) => ({
          ...part,
          awarded: scorePart(part, answers[part.id]).awarded,
        })),
      }
    : question;
  return (
    <View
      question={displayedQuestion}
      questionNumber={questionNumber}
      renderAnswer={(part) => (
        <div className="col-[2/-1] min-w-0">
          <PartRunner
            key={part.id}
            onChange={(value) => onChange(part.id, value)}
            part={part as QuestionPart}
            review={review}
            value={answers[part.id] ?? emptyAnswer(part as QuestionPart)}
          />
        </div>
      )}
    />
  );
}

/** A choice as a callout row: tip when selected; after checking, success or danger with a tag. */
function ChoiceRow({
  label,
  text,
  selected,
  correct,
  review,
  onClick,
}: {
  label: ReactNode;
  text: ReactNode;
  selected: boolean;
  correct: boolean;
  review: boolean;
  onClick?: () => void;
}) {
  const result = review && (selected || correct);
  return (
    <button
      aria-pressed={selected}
      className={cn(
        answerRowClass(
          result
            ? correct
              ? 'success'
              : 'danger'
            : !review && selected
              ? 'tip'
              : undefined
        ),
        'w-full text-left disabled:cursor-default',
        !(review || selected) && 'hover:bg-surface-hover-bg'
      )}
      disabled={review}
      onClick={onClick}
      type="button"
    >
      <OptionKey
        className={cn(
          !review &&
            selected &&
            'border-action-accent bg-action-accent text-action-accent-fg',
          review &&
            selected &&
            (correct
              ? 'border-tint-success-fg bg-tint-success-fg text-surface'
              : 'border-tint-error-fg bg-tint-error-fg text-surface'),
          review &&
            !selected &&
            correct &&
            'border-tint-success-fg text-tint-success-fg'
        )}
      >
        {review && selected ? (
          <Icon name={correct ? 'check' : 'x'} size={14} />
        ) : (
          label
        )}
      </OptionKey>
      <span className="min-w-0 flex-1 pt-px text-fg">{text}</span>
      {result && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap font-bold text-xs',
            correct ? 'text-tint-success-fg' : 'text-tint-error-fg'
          )}
        >
          {selected && <Icon name={correct ? 'check' : 'x'} size={12} />}
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
}: {
  part: QuestionPart;
  value: Answer;
  onChange: (value: Answer) => void;
  review: boolean;
}) {
  const answer = part.answer;
  // Ordering starts shuffled; matching letters follow the stored option order.
  const [order] = useState(() =>
    shuffledIndices(answer.type === 'ordering' ? answer.items.length : 0)
  );
  const [unitError, setUnitError] = useState(false);
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <div className="grid gap-1">
        {answer.options.map((option, i) => {
          const selected = Array.isArray(value) && value.includes(i);
          return (
            <ChoiceRow
              correct={answer.correct.includes(i)}
              key={i}
              label={optionLetter(i)}
              onClick={() =>
                onChange(
                  answer.type === 'mcq'
                    ? [i]
                    : selected && Array.isArray(value)
                      ? value.filter((n) => n !== i)
                      : [...(Array.isArray(value) ? value : []), i]
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
      <div className="grid gap-1">
        {[true, false].map((option) => (
          <ChoiceRow
            correct={answer.correct === option}
            key={String(option)}
            label={null}
            review
            selected={value === option}
            text={option ? m.question_ui_true() : m.question_ui_false()}
          />
        ))}
      </div>
    ) : (
      <div className="flex gap-2">
        {[true, false].map((option) => (
          <Button
            aria-pressed={value === option}
            key={String(option)}
            onClick={() => onChange(option)}
            variant={value === option ? 'accent' : 'outline'}
          >
            {option ? m.question_ui_true() : m.question_ui_false()}
          </Button>
        ))}
      </div>
    );
  if (answer.type === 'short') {
    const right = part.awarded === partMarks(part);
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <div className="relative w-44 min-w-0">
            <Input
              aria-label={m.question_ui_your_answer()}
              disabled={review}
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
              value={typeof value === 'string' ? value : ''}
              wrapperClassName={cn(
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
        {review && (
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
        disabled={review}
        onChange={(event) => onChange(event.target.value)}
        value={typeof value === 'string' ? value : ''}
      />
    );
  if (answer.type === 'matching') {
    const choices =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    const rows = (
      <ol className="grid content-start gap-1">
        {answer.pairs.map((pair, i) => {
          const chosen = choices[String(i)];
          const correct = chosen === pair.right;
          return (
            <li
              className={cn(
                answerRowClass(
                  review ? (correct ? 'success' : 'danger') : undefined
                ),
                'items-baseline'
              )}
              key={i}
            >
              <span className="w-5 shrink-0 font-bold text-fg md:w-6">
                {i + 1}.
              </span>
              <TextView className="min-w-0 flex-1 text-fg" text={pair.left} />
              {review ? (
                <span className="flex shrink-0 items-center gap-2 self-center">
                  <OptionKey
                    bare
                    className={
                      correct ? 'text-tint-success-fg' : 'text-tint-error-fg'
                    }
                  >
                    {chosen === undefined ? '–' : optionLetter(chosen)}
                  </OptionKey>
                  {!correct && (
                    <span className="whitespace-nowrap font-bold text-tint-success-fg text-xs">
                      {m.question_ui_correct_letter({
                        letter: optionLetter(pair.right),
                      })}
                    </span>
                  )}
                </span>
              ) : (
                <select
                  aria-label={pair.left}
                  className="w-16 shrink-0 self-center rounded-xl border border-line bg-surface py-1.25 pr-2 pl-3 font-bold"
                  onChange={(event) => {
                    const next = { ...choices };
                    if (event.target.value === '') delete next[String(i)];
                    else next[String(i)] = Number(event.target.value);
                    onChange(next);
                  }}
                  value={chosen ?? ''}
                >
                  <option value="">–</option>
                  {answer.options.map((_, index) => (
                    <option key={index} value={index}>
                      {optionLetter(index)}
                    </option>
                  ))}
                </select>
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
    if (review && !Array.isArray(value)) return <p>—</p>;
    const current = Array.isArray(value) ? value : order;
    function move(index: number, direction: number) {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      onChange(next);
    }
    return (
      <div className="flex flex-col gap-1">
        {current.map((item, i) => (
          <div
            className={cn(
              answerRowClass(
                review ? (item === i ? 'success' : 'danger') : undefined
              ),
              'items-center py-1.25'
            )}
            key={item}
          >
            <OptionKey
              bare
              className={cn(
                'mt-px self-start',
                review &&
                  (item === i ? 'text-tint-success-fg' : 'text-tint-error-fg')
              )}
            >
              {i + 1}
            </OptionKey>
            <TextView
              className="min-w-0 flex-1 pt-px text-fg"
              text={answer.items[item]}
            />
            {review ? (
              item !== i && (
                <span className="shrink-0 whitespace-nowrap font-bold text-tint-error-fg text-xs">
                  {m.question_ui_should_be({ position: item + 1 })}
                </span>
              )
            ) : (
              <>
                <Button
                  aria-label={m.question_ui_move_up()}
                  disabled={i === 0}
                  iconLeft="chevronUp"
                  onClick={() => move(i, -1)}
                  size="sm"
                  variant="ghost"
                />
                <Button
                  aria-label={m.question_ui_move_down()}
                  disabled={i === current.length - 1}
                  iconLeft="chevronDown"
                  onClick={() => move(i, 1)}
                  size="sm"
                  variant="ghost"
                />
              </>
            )}
          </div>
        ))}
        {!review && value === null && (
          <Button
            className="self-start"
            onClick={() => onChange(current)}
            size="sm"
            variant="ghost"
          >
            {m.question_ui_use_this_order()}
          </Button>
        )}
      </div>
    );
  }
  return null;
}
