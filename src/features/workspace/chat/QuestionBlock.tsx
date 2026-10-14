import { useState } from 'react';
import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount, Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { composeAnswers, type QuestionAnswer } from './questions';
import type { AskUserProps } from './schema';

/**
 * The latest reply's questions, one at a time, in the composer's place.
 * Picking an option moves to the next unanswered question, Skip leaves one
 * out, one Send posts every answer as a single user message, and ✕ dismisses
 * the set so the composer returns. State is local and dies with the block.
 */
export function QuestionBlock({
  questions,
  disabled,
  onSend,
  onDismiss,
}: {
  questions: AskUserProps[];
  disabled?: boolean;
  onSend: (text: string) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => ({}))
  );
  const [skipped, setSkipped] = useState<boolean[]>(() =>
    questions.map(() => false)
  );

  const answered = (i: number) =>
    !!(answers[i]?.choice || answers[i]?.other?.trim());
  const done = questions.filter((_, i) => answered(i)).length;
  const composed = composeAnswers(questions, answers);
  const composedLength = textLength(composed);
  const overLimit = composedLength > CHAT_CHARACTER_LIMIT;
  const current = questions[index];
  if (!current) return null;

  const show = (i: number) =>
    setIndex((i + questions.length) % questions.length);
  const advance = () => {
    const next = questions.findIndex(
      (_, i) => i > index && !answered(i) && !skipped[i]
    );
    if (next !== -1) setIndex(next);
  };
  const update = (patch: QuestionAnswer) =>
    setAnswers((prev) =>
      prev.map((answer, i) => (i === index ? { ...answer, ...patch } : answer))
    );
  const choose = (choice: string) => {
    update({ choice });
    setSkipped((prev) => prev.map((flag, i) => (i === index ? false : flag)));
    advance();
  };
  const skip = () => {
    update({ choice: undefined, other: '' });
    setSkipped((prev) => prev.map((flag, i) => (i === index ? true : flag)));
    if (index < questions.length - 1) show(index + 1);
  };

  return (
    <section
      aria-label={current.question}
      className="flex flex-col rounded-input border border-line bg-surface px-3 pt-2 pb-2 text-sm"
      onKeyDown={(event) => {
        const target = event.target as HTMLInputElement;
        if (target.tagName === 'INPUT' && target.type !== 'radio') return;
        const n = Number(event.key);
        if (n >= 1 && n <= current.choices.length)
          choose(current.choices[n - 1]);
      }}
    >
      <div className="mb-1.5 flex items-start gap-1">
        <p className="flex-1 pt-1 font-semibold text-sm leading-snug">
          {current.question}
          {skipped[index] ? (
            <span className="font-normal text-fg-muted">
              {' '}
              · {m.chat_question_skipped()}
            </span>
          ) : null}
        </p>
        {questions.length > 1 ? (
          <>
            <IconButton
              icon="chevronLeft"
              label={m.chat_question_previous()}
              onClick={() => show(index - 1)}
              size="xs"
            />
            <span className="pt-1 text-[11px] text-fg-muted">
              {m.chat_question_progress({
                count: questions.length,
                index: index + 1,
              })}
            </span>
            <IconButton
              icon="chevronRight"
              label={m.chat_question_next()}
              onClick={() => show(index + 1)}
              size="xs"
            />
          </>
        ) : null}
        <IconButton
          className="text-fg-secondary"
          icon="x"
          label={m.chat_question_dismiss()}
          onClick={onDismiss}
          size="xs"
        />
      </div>
      <div role="radiogroup">
        {current.choices.map((choice, i) => {
          const selected = answers[index]?.choice === choice;
          return (
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2.5 border-divider border-t px-1 py-1.5 text-sm hover:bg-surface-hover-bg',
                selected && 'font-semibold text-tint-accent-1-fg'
              )}
              key={`${i}-${choice}`}
            >
              <input
                checked={selected}
                className="sr-only"
                name={`question-${index}`}
                onChange={() => choose(choice)}
                type="radio"
                value={choice}
              />
              <span
                className={cn(
                  'grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-page font-semibold text-[10px] text-fg-muted',
                  selected && 'bg-action-accent text-action-accent-fg'
                )}
              >
                {i + 1}
              </span>
              {choice}
            </label>
          );
        })}
      </div>
      <Input
        aria-label={
          current.choices.length
            ? m.chat_question_other()
            : m.chat_question_type()
        }
        leftIcon="pencil"
        onChange={(event) => {
          update({ other: event.target.value });
          if (event.target.value.trim()) {
            setSkipped((prev) =>
              prev.map((flag, i) => (i === index ? false : flag))
            );
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && answers[index]?.other?.trim()) {
            event.preventDefault();
            advance();
          }
        }}
        placeholder={
          current.choices.length
            ? m.chat_question_other()
            : m.chat_question_type()
        }
        size="sm"
        value={answers[index]?.other ?? ''}
        variant="transparent"
        wrapperClassName="rounded-none border-divider border-y px-1 pb-1.5 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={skip} size="sm" variant="ghost-hover">
          {m.chat_question_skip()}
        </Button>
        <span className="ml-auto" />
        {overLimit ? (
          <CharCount max={CHAT_CHARACTER_LIMIT} value={composedLength} />
        ) : questions.length > 1 ? (
          <span className="text-[11px] text-fg-muted">
            {m.chat_question_answered({ count: questions.length, done })}
          </span>
        ) : null}
        <IconButton
          className="p-2.5"
          disabled={disabled || done === 0 || overLimit}
          icon="send"
          label={m.chat_question_send()}
          onClick={() => onSend(composed)}
          size="sm"
          variant="accent"
        />
      </div>
    </section>
  );
}
