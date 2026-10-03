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
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import type { MarkItem, QuestionAnswer, QuestionType } from './types';
import { QUESTION_TYPES } from './types';

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="t-label" htmlFor={id}>
        {label}
      </label>
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
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="t-label" htmlFor={id}>
        {label}
      </label>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label} id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
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
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  onRemove?: (index: number) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="t-label">{label}</p>
      {values.map((value, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            aria-label={m.question_ui_numbered_item({
              label,
              number: index + 1,
            })}
            onChange={(e) =>
              onChange(
                values.map((item, i) => (i === index ? e.target.value : item))
              )
            }
            value={value}
          />
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
  onChange,
}: {
  label: string;
  items: MarkItem[];
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
          <Input
            aria-label={m.question_ui_numbered_item({
              label,
              number: index + 1,
            })}
            onChange={(e) => update(index, { text: e.target.value })}
            value={item.text}
          />
          <Select
            onValueChange={(value) => update(index, { marks: Number(value) })}
            value={String(item.marks)}
          >
            <SelectTrigger
              aria-label={m.question_ui_item_marks({ number: index + 1 })}
              className="w-20 shrink-0"
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
  matching: m.question_ui_matching,
  mcq: m.question_ui_multiple_choice,
  multi: m.question_ui_multiple_answers,
  open: m.question_ui_open_answer,
  ordering: m.question_ui_ordering,
  short: m.question_ui_short_answer,
};
export function emptyAnswer(type: QuestionType): QuestionAnswer {
  switch (type) {
    case 'mcq':
    case 'multi':
      return { correct: [], options: ['', ''], type };
    case 'boolean':
      return { correct: true, type };
    case 'short':
      return { accepted: [''], type };
    case 'open':
      return { accepted: [''], hints: [], type };
    case 'matching':
      return { options: ['', ''], pairs: [{ left: '', right: 0 }], type };
    case 'ordering':
      return { items: ['', ''], type };
  }
}

export function AnswerEditor({
  answer,
  onChange,
}: {
  answer: QuestionAnswer;
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
      {(answer.type === 'mcq' || answer.type === 'multi') && (
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
                    correct:
                      answer.type === 'mcq'
                        ? [i]
                        : event.target.checked
                          ? [...answer.correct, i]
                          : answer.correct.filter((value) => value !== i),
                  })
                }
                type={answer.type === 'mcq' ? 'radio' : 'checkbox'}
              />
              <Input
                aria-label={m.question_ui_option_number({ number: i + 1 })}
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
      {(answer.type === 'short' || answer.type === 'open') && (
        <StringList
          label={m.question_ui_accepted_answers()}
          onChange={(accepted) => onChange({ ...answer, accepted })}
          values={answer.accepted}
        />
      )}
      {answer.type === 'short' && (
        <Field label={m.question_ui_unit()}>
          <Input
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
              <Field label={m.question_ui_item_number({ number: i + 1 })}>
                <Input
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
