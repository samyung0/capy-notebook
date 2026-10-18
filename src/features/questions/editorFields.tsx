import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from 'react';
import * as limits from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  CharCount,
  type CountLimit,
  Input,
  type InputProps,
} from '@/components/ui/Input';
import { PopoverClose } from '@/components/ui/Popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { ToolbarPopoverItem } from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import type { MarkItem, QuestionAnswer, QuestionType } from './types';
import { QUESTION_TYPES } from './types';

/** Question editor inputs: the compact underline the answer options use. */
export function FieldInput({ wrapperClassName, ...props }: InputProps) {
  return (
    <Input
      variant="underline"
      wrapperClassName={cn('h-9 w-full min-w-0 px-0.5', wrapperClassName)}
      {...props}
    />
  );
}

/** A row in a question editor's popover menu, closing it when chosen. */
export function MenuItem(
  props: React.ComponentProps<typeof ToolbarPopoverItem>
) {
  return (
    <PopoverClose asChild>
      <ToolbarPopoverItem {...props} />
    </PopoverClose>
  );
}

export function Field({
  label,
  count,
  children,
}: {
  label: string;
  count?: CountLimit;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <label className="t-label" htmlFor={id}>
          {label}
        </label>
        {count && <CharCount className="ml-auto" {...count} />}
      </div>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
    </div>
  );
}
export function SelectField({
  label,
  value,
  options,
  onChange,
  className,
}: {
  className?: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={cn('flex min-w-0 max-w-full flex-col gap-0.5', className)}>
      <label className="t-label" htmlFor={id}>
        {label}
      </label>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger
          aria-label={label}
          className="h-9 bg-transparent px-0.5"
          id={id}
          variant="underline"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" variant="menu">
          {options.map((option) => (
            <SelectItem key={option.value} size="menu" value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function StringList({
  label,
  values,
  onChange,
  onRemove,
  onMove,
  maxLength = limits.QUESTION_TEXT_MAX,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  onRemove?: (index: number) => void;
  /** Swaps an option with its neighbour (the matching option pool, Epo
   * 2026-10-18): each row gets up and down buttons, and Alt+ArrowUp or
   * Alt+ArrowDown moves the focused option, focus following it. */
  onMove?: (from: number, to: number) => void;
  /** Characters an item holds at most (its input stops there). */
  maxLength?: number;
}) {
  return (
    <div className="space-y-2" data-string-list>
      <p className="t-label">{label}</p>
      {values.map((value, index) => (
        <div className="flex items-center gap-2" key={index}>
          <FieldInput
            aria-label={m.question_ui_numbered_item({
              label,
              number: index + 1,
            })}
            maxLength={maxLength}
            onChange={(e) =>
              onChange(
                values.map((item, i) => (i === index ? e.target.value : item))
              )
            }
            onKeyDown={(event) => {
              const to =
                event.key === 'ArrowUp'
                  ? index - 1
                  : event.key === 'ArrowDown'
                    ? index + 1
                    : -1;
              if (!(onMove && event.altKey) || to < 0 || to >= values.length)
                return;
              event.preventDefault();
              onMove(index, to);
              // Rows are keyed by place, so the input at `to` holds it next.
              event.currentTarget
                .closest('[data-string-list]')
                ?.querySelectorAll('input')
                [to]?.focus();
            }}
            value={value}
          />
          {onMove && (
            <>
              <ToolbarButton
                disabled={index === 0}
                label={m.question_ui_move_option_up({ number: index + 1 })}
                onClick={() => onMove(index, index - 1)}
                shortcut="Alt+↑"
              >
                <Icon name="arrowUp" />
              </ToolbarButton>
              <ToolbarButton
                disabled={index === values.length - 1}
                label={m.question_ui_move_option_down({ number: index + 1 })}
                onClick={() => onMove(index, index + 1)}
                shortcut="Alt+↓"
              >
                <Icon name="arrowDown" />
              </ToolbarButton>
            </>
          )}
          <ToolbarButton
            label={m.question_ui_remove_item({ label, number: index + 1 })}
            onClick={() =>
              onRemove
                ? onRemove(index)
                : onChange(values.filter((_, i) => i !== index))
            }
          >
            <Icon name="trash" />
          </ToolbarButton>
        </div>
      ))}
      <Button
        disabled={values.length >= limits.QUESTION_ANSWERS_MAX}
        iconLeft="plus"
        onClick={() => onChange([...values, ''])}
        size="sm"
        type="button"
        variant="ghost"
      >
        {m.question_ui_add_item()}
      </Button>
    </div>
  );
}
export const markOptions = Array.from(
  { length: limits.QUESTION_MARKS_MAX },
  (_, i) => ({ label: String(i + 1), value: String(i + 1) })
);

/** An open part's marking items, each with its own whole marks. */
export function MarkschemeList({
  label,
  items,
  max,
  onChange,
}: {
  label: string;
  items: MarkItem[];
  /** Marking items a part holds at most (a quiz's bound is lower). */
  max: number;
  onChange: (items: MarkItem[]) => void;
}) {
  const update = (index: number, change: Partial<MarkItem>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...change } : item))
    );
  return (
    <div className="space-y-2">
      <p className="t-label">{label}</p>
      {items.map((item, index) => (
        <div className="flex items-center gap-2" key={index}>
          <FieldInput
            aria-label={m.question_ui_numbered_item({
              label,
              number: index + 1,
            })}
            maxLength={limits.QUESTION_MARK_ITEM_MAX}
            onChange={(e) => update(index, { text: e.target.value })}
            value={item.text}
          />
          <Select
            onValueChange={(value) => update(index, { marks: Number(value) })}
            value={String(item.marks)}
          >
            <SelectTrigger
              aria-label={m.question_ui_item_marks({ number: index + 1 })}
              className="h-9 w-16 shrink-0 bg-transparent px-0.5"
              variant="underline"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {markOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolbarButton
            label={m.question_ui_remove_item({ label, number: index + 1 })}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
          >
            <Icon name="trash" />
          </ToolbarButton>
        </div>
      ))}
      <Button
        disabled={items.length >= max}
        iconLeft="plus"
        onClick={() => onChange([...items, { marks: 1, text: '' }])}
        size="sm"
        type="button"
        variant="ghost"
      >
        {m.question_ui_add_item()}
      </Button>
    </div>
  );
}
export const answerLabels: Record<QuestionType, () => string> = {
  boolean: m.question_ui_true_false,
  gaps: m.question_ui_fill_in_the_gaps,
  matching: m.question_ui_matching,
  mcq: m.question_ui_multiple_choice,
  open: m.question_ui_open_answer,
  ordering: m.question_ui_ordering,
  short: m.question_ui_short_answer,
};
export function emptyAnswer(type: QuestionType): QuestionAnswer {
  switch (type) {
    case 'mcq':
      return { correct: [], options: ['', ''], type };
    case 'boolean':
      return { correct: true, type };
    case 'short':
      return { accepted: [''], type };
    case 'open':
      return { accepted: [], hints: [], type };
    case 'matching':
      return { options: ['', ''], pairs: [{ left: '', right: 0 }], type };
    case 'ordering':
      return { items: ['', ''], type };
    case 'gaps':
      return { accepted: [['']], type };
  }
}

export function AnswerEditor({
  answer,
  bank,
  onChange,
}: {
  answer: QuestionAnswer;
  /** A bank question: open answers take the bank's longer text bound. */
  bank: boolean;
  onChange: (answer: QuestionAnswer) => void;
}) {
  return (
    <div className="space-y-4">
      <SelectField
        label={m.question_ui_answer_type()}
        onChange={(value) => onChange(emptyAnswer(value as QuestionType))}
        options={QUESTION_TYPES.map((value) => ({
          label: answerLabels[value](),
          value,
        }))}
        value={answer.type}
      />
      {answer.type === 'mcq' && (
        <div className="space-y-2">
          <p className="t-label">
            {m.question_ui_options_and_correct_answers()}
          </p>
          {answer.options.map((option, i) => (
            <div className="flex items-center gap-2" key={i}>
              <input
                aria-label={m.question_ui_correct_option({ number: i + 1 })}
                checked={answer.correct.includes(i)}
                onChange={(event) =>
                  onChange({
                    ...answer,
                    correct: event.target.checked
                      ? [...answer.correct, i]
                      : answer.correct.filter((value) => value !== i),
                  })
                }
                type="checkbox"
              />
              <FieldInput
                aria-label={m.question_ui_option_number({ number: i + 1 })}
                maxLength={limits.QUESTION_TEXT_MAX}
                onChange={(event) =>
                  onChange({
                    ...answer,
                    options: answer.options.map((value, j) =>
                      j === i ? event.target.value : value
                    ),
                  })
                }
                value={option}
              />
              <ToolbarButton
                label={m.question_ui_remove_option({ number: i + 1 })}
                onClick={() =>
                  onChange({
                    ...answer,
                    correct: answer.correct
                      .filter((value) => value !== i)
                      .map((value) => (value > i ? value - 1 : value)),
                    options: answer.options.filter((_, j) => i !== j),
                  })
                }
              >
                <Icon name="trash" />
              </ToolbarButton>
            </div>
          ))}
          <Button
            disabled={answer.options.length >= limits.QUESTION_ANSWERS_MAX}
            iconLeft="plus"
            onClick={() =>
              onChange({ ...answer, options: [...answer.options, ''] })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {m.question_ui_add_option()}
          </Button>
        </div>
      )}
      {answer.type === 'boolean' && (
        <SelectField
          label={m.question_ui_correct_answer()}
          onChange={(value) =>
            onChange({ ...answer, correct: value === 'true' })
          }
          options={[
            { label: m.question_ui_true(), value: 'true' },
            { label: m.question_ui_false(), value: 'false' },
          ]}
          value={String(answer.correct)}
        />
      )}
      {answer.type === 'short' && (
        <StringList
          label={m.question_ui_accepted_answers()}
          onChange={(accepted) => onChange({ ...answer, accepted })}
          values={answer.accepted}
        />
      )}
      {answer.type === 'open' && (
        // At most one sample answer, and it is optional (Epo 2026-10-15).
        <Field
          count={{
            max: bank ? limits.QUESTION_TEXT_MAX : limits.QUIZ_OPEN_ANSWER_MAX,
            value: textLength(answer.accepted[0]),
          }}
          label={m.question_ui_sample_answer()}
        >
          <FieldInput
            maxLength={
              bank ? limits.QUESTION_TEXT_MAX : limits.QUIZ_OPEN_ANSWER_MAX
            }
            onChange={(event) =>
              onChange({
                ...answer,
                accepted: event.target.value ? [event.target.value] : [],
              })
            }
            value={answer.accepted[0] ?? ''}
          />
        </Field>
      )}
      {answer.type === 'short' && (
        <Field
          count={{
            max: limits.QUESTION_UNIT_MAX,
            value: textLength(answer.unit),
          }}
          label={m.question_ui_unit()}
        >
          <FieldInput
            maxLength={limits.QUESTION_UNIT_MAX}
            onChange={(event) =>
              onChange({ ...answer, unit: event.target.value || undefined })
            }
            value={answer.unit ?? ''}
          />
        </Field>
      )}
      {answer.type === 'open' && (
        <StringList
          label={m.question_ui_hints()}
          onChange={(hints) => onChange({ ...answer, hints })}
          values={answer.hints}
        />
      )}
      {answer.type === 'gaps' && (
        <div className="space-y-4">
          {answer.accepted.map((accepted, i) => (
            <div className="flex items-start gap-2" key={i}>
              <div className="min-w-0 flex-1">
                <StringList
                  label={m.question_ui_gap({ number: i + 1 })}
                  onChange={(values) =>
                    onChange({
                      ...answer,
                      accepted: answer.accepted.map((item, j) =>
                        j === i ? values : item
                      ),
                    })
                  }
                  values={accepted}
                />
              </div>
              <ToolbarButton
                label={m.question_ui_remove_gap({ number: i + 1 })}
                onClick={() =>
                  onChange({
                    ...answer,
                    accepted: answer.accepted.filter((_, j) => j !== i),
                  })
                }
              >
                <Icon name="trash" />
              </ToolbarButton>
            </div>
          ))}
          <Button
            disabled={answer.accepted.length >= limits.QUESTION_ANSWERS_MAX}
            iconLeft="plus"
            onClick={() =>
              onChange({ ...answer, accepted: [...answer.accepted, ['']] })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {m.question_ui_add_gap()}
          </Button>
        </div>
      )}
      {answer.type === 'ordering' && (
        <StringList
          label={m.question_ui_items_in_correct_order()}
          onChange={(items) => onChange({ ...answer, items })}
          values={answer.items}
        />
      )}
      {answer.type === 'matching' && (
        <>
          <StringList
            label={m.question_ui_choice_pool()}
            onChange={(options) => onChange({ ...answer, options })}
            onMove={(from, to) =>
              onChange({
                ...answer,
                options: answer.options.map((option, i) =>
                  i === from
                    ? answer.options[to]
                    : i === to
                      ? answer.options[from]
                      : option
                ),
                // Each prompt keeps its answer as the options swap.
                pairs: answer.pairs.map((pair) => ({
                  ...pair,
                  right:
                    pair.right === from
                      ? to
                      : pair.right === to
                        ? from
                        : pair.right,
                })),
              })
            }
            onRemove={(index) =>
              onChange({
                ...answer,
                options: answer.options.filter((_, i) => i !== index),
                pairs: answer.pairs.map((pair) => ({
                  ...pair,
                  right:
                    pair.right === index
                      ? -1
                      : pair.right > index
                        ? pair.right - 1
                        : pair.right,
                })),
              })
            }
            values={answer.options}
          />
          <p className="t-label">{m.question_ui_matches()}</p>
          {answer.pairs.map((pair, i) => (
            <div className="flex items-end gap-2" key={i}>
              <Field
                count={{
                  max: limits.QUESTION_TEXT_MAX,
                  value: textLength(pair.left),
                }}
                label={m.question_ui_item_number({ number: i + 1 })}
              >
                <FieldInput
                  maxLength={limits.QUESTION_TEXT_MAX}
                  onChange={(event) =>
                    onChange({
                      ...answer,
                      pairs: answer.pairs.map((value, j) =>
                        j === i ? { ...value, left: event.target.value } : value
                      ),
                    })
                  }
                  value={pair.left}
                />
              </Field>
              <SelectField
                label={m.question_ui_correct_choice()}
                onChange={(value) =>
                  onChange({
                    ...answer,
                    pairs: answer.pairs.map((pair, j) =>
                      j === i ? { ...pair, right: Number(value) } : pair
                    ),
                  })
                }
                options={answer.options.map((label, index) => ({
                  label: `${String.fromCharCode(65 + index)}. ${label}`,
                  value: String(index),
                }))}
                value={String(pair.right)}
              />
              <ToolbarButton
                label={m.question_ui_remove_match({ number: i + 1 })}
                onClick={() =>
                  onChange({
                    ...answer,
                    pairs: answer.pairs.filter((_, j) => i !== j),
                  })
                }
              >
                <Icon name="trash" />
              </ToolbarButton>
            </div>
          ))}
          <Button
            disabled={answer.pairs.length >= limits.QUESTION_ANSWERS_MAX}
            iconLeft="plus"
            onClick={() =>
              onChange({
                ...answer,
                pairs: [...answer.pairs, { left: '', right: 0 }],
              })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {m.question_ui_add_match()}
          </Button>
        </>
      )}
    </div>
  );
}
