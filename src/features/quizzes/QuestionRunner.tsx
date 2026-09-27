import { useState } from 'react';
import type { Question, QuestionPart } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Input, InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import {
  QuestionReview,
  QuestionView,
  TextView,
} from '@/features/questions/QuestionView';
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
        <PartRunner
          key={part.id}
          onChange={(value) => onChange(part.id, value)}
          part={part as QuestionPart}
          review={review}
          value={answers[part.id] ?? emptyAnswer(part as QuestionPart)}
        />
      )}
    />
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
  const [order] = useState(() =>
    shuffledIndices(
      answer.type === 'matching'
        ? answer.options.length
        : answer.type === 'ordering'
          ? answer.items.length
          : 0
    )
  );
  const [unitError, setUnitError] = useState(false);
  if (answer.type === 'mcq' || answer.type === 'multi')
    return (
      <div className="flex flex-col gap-2">
        {answer.options.map((option, i) => {
          const selected = Array.isArray(value) && value.includes(i);
          const correct = answer.correct.includes(i);
          return (
            <button
              aria-pressed={selected}
              className={cn(
                'flex items-start gap-3 rounded-input border border-line px-3 py-2 text-left',
                selected && 'border-accent bg-tint-accent-1',
                review && correct && 'border-solid-success bg-tint-success',
                review &&
                  selected &&
                  !correct &&
                  'border-solid-error bg-tint-error'
              )}
              disabled={review}
              key={i}
              onClick={() =>
                onChange(
                  answer.type === 'mcq'
                    ? [i]
                    : selected && Array.isArray(value)
                      ? value.filter((n) => n !== i)
                      : [...(Array.isArray(value) ? value : []), i]
                )
              }
              type="button"
            >
              <span className="t-label w-5 shrink-0">
                {String.fromCharCode(65 + i)}.
              </span>
              <TextView text={option} />
            </button>
          );
        })}
      </div>
    );
  if (answer.type === 'boolean')
    return (
      <div className="flex gap-2">
        {[true, false].map((option) => (
          <Button
            aria-pressed={value === option}
            disabled={review}
            key={String(option)}
            onClick={() => onChange(option)}
            variant={value === option ? 'accent' : 'outline'}
          >
            {option ? m.question_ui_true() : m.question_ui_false()}
          </Button>
        ))}
      </div>
    );
  if (answer.type === 'short')
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
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
            wrapperClassName="flex-1"
          />
          {answer.unit && (
            <span className="shrink-0 text-fg-secondary">{answer.unit}</span>
          )}
        </div>
        {unitError && (
          <InputError>
            {m.question_ui_value_only({ unit: answer.unit })}
          </InputError>
        )}
      </div>
    );
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
    return (
      <div className="flex flex-col gap-3">
        {answer.pairs.map((pair, i) => (
          <div className="grid grid-cols-2 items-center gap-3" key={i}>
            <TextView text={pair.left} />
            <select
              aria-label={pair.left}
              className="min-w-0 rounded-input border border-line bg-surface px-3 py-2"
              disabled={review}
              onChange={(event) => {
                const next = { ...choices };
                if (event.target.value === '') delete next[String(i)];
                else next[String(i)] = Number(event.target.value);
                onChange(next);
              }}
              value={choices[String(i)] ?? ''}
            >
              <option value="">{m.question_ui_choose()}</option>
              {(review ? answer.options.map((_, index) => index) : order).map(
                (index) => (
                  <option key={index} value={index}>
                    {answer.options[index]}
                  </option>
                )
              )}
            </select>
          </div>
        ))}
      </div>
    );
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
      <div className="flex flex-col gap-2">
        {current.map((item, i) => (
          <div
            className="flex items-center gap-2 rounded-input border border-line p-2"
            key={item}
          >
            <span className="t-label w-5">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <TextView text={answer.items[item]} />
            </div>
            <Button
              aria-label={m.question_ui_move_up()}
              disabled={review || i === 0}
              iconLeft="chevronUp"
              onClick={() => move(i, -1)}
              size="sm"
              variant="ghost"
            />
            <Button
              aria-label={m.question_ui_move_down()}
              disabled={review || i === current.length - 1}
              iconLeft="chevronDown"
              onClick={() => move(i, 1)}
              size="sm"
              variant="ghost"
            />
          </div>
        ))}
        {!review && value === null && (
          <Button onClick={() => onChange(current)} size="sm" variant="ghost">
            {m.question_ui_use_this_order()}
          </Button>
        )}
      </div>
    );
  }
  return null;
}
