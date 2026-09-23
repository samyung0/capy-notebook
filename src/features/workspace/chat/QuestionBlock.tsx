import { useState } from 'react';
import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { chatInputLimit } from '../chatInputLimit';
import { composeAnswers, type QuestionAnswer } from './questions';
import type { AskUserProps } from './schema';

const questionBarLabel = (count: number) =>
  count === 1 ? m.chat_question_bar_one() : m.chat_question_bar({ count });

/**
 * The docked question block: the latest reply's questions, one at a time,
 * between the message list and the composer. Picking an option moves to the
 * next unanswered question, Skip leaves one out, and one Send posts every
 * answer as a single user message. State is local and dies with the block.
 */
export function QuestionBlock({
  questions,
  disabled,
  onSend,
}: {
  questions: AskUserProps[];
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => ({}))
  );
  const [skipped, setSkipped] = useState<boolean[]>(() =>
    questions.map(() => false)
  );
  const [hidden, setHidden] = useState(false);

  const answered = (i: number) =>
    !!(answers[i]?.choice || answers[i]?.other?.trim());
  const done = questions.filter((_, i) => answered(i)).length;
  const composed = composeAnswers(questions, answers);
  const limit = chatInputLimit(composed);
  const overLimit = limit.exceeded;
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

  if (hidden) {
    return (
      <div className="mx-3 mb-1.5 flex items-center justify-between gap-2 rounded-card border border-action-accent bg-surface px-2.5 py-1.5 text-xs">
        <span>{questionBarLabel(questions.length)}</span>
        <Button onClick={() => setHidden(false)} size="xs" variant="ghost-link">
          {m.chat_question_show()}
        </Button>
      </div>
    );
  }

  return (
    <section
      aria-label={questionBarLabel(questions.length)}
      className="relative mx-3 mb-1.5 rounded-card border border-action-accent bg-surface px-3.5 py-3 text-sm"
      onKeyDown={(event) => {
        const target = event.target as HTMLInputElement;
        if (target.tagName === 'INPUT' && target.type !== 'radio') return;
        const n = Number(event.key);
        if (n >= 1 && n <= current.choices.length)
          choose(current.choices[n - 1]);
      }}
    >
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        {questions.length > 1 ? (
          <>
            <IconButton
              icon="chevronLeft"
              label={m.chat_question_previous()}
              onClick={() => show(index - 1)}
              size="sm"
              variant="ghost"
            />
            <span className="text-[11px] text-fg-muted">
              {m.chat_question_progress({
                count: questions.length,
                index: index + 1,
              })}
            </span>
            <IconButton
              icon="chevronRight"
              label={m.chat_question_next()}
              onClick={() => show(index + 1)}
              size="sm"
              variant="ghost"
            />
          </>
        ) : null}
        <IconButton
          icon="x"
          label={m.chat_question_hide()}
          onClick={() => setHidden(true)}
          size="sm"
          variant="ghost"
        />
      </div>
      <p className="mr-28 mb-1.5 font-semibold text-[13px] leading-snug">
        {current.question}
        {skipped[index] ? (
          <span className="font-normal text-fg-muted">
            {' '}
            · {m.chat_question_skipped()}
          </span>
        ) : null}
      </p>
      <div role="radiogroup">
        {current.choices.map((choice, i) => {
          const selected = answers[index]?.choice === choice;
          return (
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-button border-divider border-t px-1.5 py-2 text-xs hover:bg-surface-hover-bg',
                selected && 'bg-tint-accent-1'
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
                  'grid size-5 shrink-0 place-items-center rounded-button bg-page font-semibold text-[10px] text-fg-muted',
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
      <div className="flex items-center gap-2 border-divider border-t pt-1">
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
          wrapperClassName="flex-1"
        />
        <Button onClick={skip} size="sm" variant="outline">
          {m.chat_question_skip()}
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2 border-divider border-t pt-2">
        <Button
          disabled={disabled || done === 0 || overLimit}
          onClick={() => onSend(composed)}
          size="sm"
          variant="accent"
        >
          {done > 1
            ? m.chat_question_send_many({ count: done })
            : m.chat_question_send()}
        </Button>
        <span className="text-[11px] text-fg-muted">
          {overLimit
            ? `${limit.count}/${CHAT_CHARACTER_LIMIT}`
            : m.chat_question_hint()}
        </span>
      </div>
    </section>
  );
}
