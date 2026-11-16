import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import * as limits from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
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
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { ToolbarPopoverItem } from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { MatchingGrid } from './MatchingGrid';
import {
  type MarkItem,
  multipleAnswers,
  type QuestionAnswer,
  type QuestionType,
  schemeMarks,
} from './types';

const NOT_DIGITS = /\D/g;

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

/** A card's row input (board Main): its underline shows on hover, while
 * empty and in accent while typing, as Google Forms' options. */
function CardInput({ wrapperClassName, ...props }: InputProps) {
  return (
    <FieldInput
      wrapperClassName={cn(
        // Hover greys the underline only while not typing, so the accent stays.
        'h-10 border-transparent focus-within:border-b-2 hover:not-focus-within:border-line',
        !props.value && 'border-line',
        wrapperClassName
      )}
      {...props}
    />
  );
}

/** A question editor's written text on ruled lines, as learners write
 * theirs: `lines` tall, growing two more before it scrolls. */
export function FieldTextarea({
  lines,
  className,
  ...props
}: React.ComponentProps<'textarea'> & { lines: 2 | 3 }) {
  return (
    <Textarea
      className={cn(
        'ruled-lines rounded-none border-0 bg-transparent px-0.5 py-0 focus:border-0',
        lines === 2
          ? 'max-h-[calc(var(--ruled-line)*4)] min-h-[calc(var(--ruled-line)*2)]'
          : 'max-h-[calc(var(--ruled-line)*5)] min-h-[calc(var(--ruled-line)*3)]',
        className
      )}
      {...props}
    />
  );
}

/** A list's Add button, its plus in line with the inputs above it. */
function AddButton(props: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      className="-ml-4"
      iconLeft="plus"
      size="sm"
      type="button"
      variant="ghost-hover"
      {...props}
    />
  );
}

/** A card list's last row (board Main's Add option): muted words where the
 * rows' inputs are, as wide, their underline showing on hover as theirs does,
 * after what stands where the rows' markers do. */
function AddRow({
  disabled,
  label,
  lead,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  /** The rows' marker, faded: a radio, a number. */
  lead?: ReactNode;
  onClick: () => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      {lead}
      <button
        className="h-10 min-w-0 flex-1 cursor-pointer border-transparent border-b px-0.5 text-left text-fg-muted outline-none hover:border-line hover:text-fg focus-visible:ring-2 focus-visible:ring-action disabled:cursor-default disabled:opacity-50"
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {label}
      </button>
      {/* Where the rows' remove button is, so it ends where their inputs do. */}
      <span aria-hidden className="size-(--toolbar-button) shrink-0" />
    </div>
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
  className,
  children,
}: {
  label: string;
  count?: CountLimit;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
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

/** Whole marks from 1 to `max`, typed in the card's small box as Google
 * Forms' points (Epo 2026-11-15): a number in range takes at once, anything
 * else goes back to the marks on leaving; the arrow keys step them. */
export function MarksInput({
  className,
  label,
  max = limits.QUESTION_MARKS_MAX,
  onChange,
  value,
}: {
  className?: string;
  label: string;
  max?: number;
  onChange: (marks: number) => void;
  value: number;
}) {
  // What is typed while it is not yet marks; null shows the marks.
  const [draft, setDraft] = useState<string | null>(null);
  const top = Math.max(max, value);
  const take = (text: string) => {
    const digits = text.replace(NOT_DIGITS, '').slice(0, 2);
    setDraft(digits);
    const marks = Number(digits);
    if (digits && marks >= 1 && marks <= top && marks !== value)
      onChange(marks);
  };
  const shown = draft ?? String(value);
  const invalid =
    draft !== null && !(Number(draft) >= 1 && Number(draft) <= top);
  return (
    <input
      aria-invalid={invalid || undefined}
      aria-label={label}
      autoComplete="off"
      className={cn(
        'h-8 w-13 rounded-input border border-line bg-field px-2 text-center text-fg outline-none hover:border-line-strong focus:border-action-accent aria-invalid:border-tint-error-fg',
        className
      )}
      inputMode="numeric"
      onBlur={() => setDraft(null)}
      onChange={(event) => take(event.target.value)}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        const step =
          event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = Math.min(top, Math.max(1, value + step));
        setDraft(null);
        if (next !== value) onChange(next);
      }}
      value={shown}
    />
  );
}

export function StringList({
  label,
  values,
  onChange,
  addLabel = m.question_ui_add_item(),
  className,
  maxLength = limits.QUESTION_TEXT_MAX,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** The Add button's words, where "Add item" says too little. */
  addLabel?: string;
  className?: string;
  /** Characters an item holds at most (its input stops there). */
  maxLength?: number;
}) {
  return (
    <div className={cn('space-y-2', className)}>
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
            value={value}
          />
          <ToolbarButton
            label={m.question_ui_remove_item({ label, number: index + 1 })}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <Icon name="trash" />
          </ToolbarButton>
        </div>
      ))}
      <AddButton
        disabled={values.length >= limits.QUESTION_ANSWERS_MAX}
        onClick={() => onChange([...values, m.question_default_answer()])}
      >
        {addLabel}
      </AddButton>
    </div>
  );
}

export const answerLabels: Record<QuestionType, () => string> = {
  boolean: m.question_ui_true_false,
  drawing: m.question_ui_drawing,
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
      return { correct: [], options: defaultOptions(), type };
    case 'boolean':
      return { correct: true, type };
    case 'short':
      return { accepted: [m.question_default_answer()], type };
    case 'open':
      return { accepted: [], type };
    case 'matching':
      return {
        options: [1, 2].map((number) => m.question_default_column({ number })),
        pairs: [{ left: m.question_default_row({ number: 1 }), right: 0 }],
        type,
      };
    case 'ordering':
      return {
        items: [1, 2].map((number) => m.question_default_item({ number })),
        type,
      };
    case 'gaps':
      return { accepted: [[m.question_default_answer()]], type };
    case 'drawing':
      return { type };
  }
}

/** A new choice part's options, as Google Forms names them. */
const defaultOptions = () =>
  [1, 2].map((number) => m.question_default_option({ number }));

/** The type menu's entries: the answer types, Multiple answer being an mcq
 * answered with checkboxes (`multiple`, Epo 2026-11-15). */
export type AnswerKind = QuestionType | 'multiple';

export const answerKind = (answer: QuestionAnswer): AnswerKind =>
  answer.type === 'mcq' && multipleAnswers(answer) ? 'multiple' : answer.type;

const kindLabels: Record<AnswerKind, () => string> = {
  ...answerLabels,
  multiple: m.question_ui_multiple_answer,
};

export const kindIcons: Record<AnswerKind, IconName> = {
  boolean: 'toggle',
  drawing: 'pencil',
  gaps: 'blanks',
  matching: 'grid',
  mcq: 'radio',
  multiple: 'checkSquare',
  open: 'alignLeft',
  ordering: 'listOrdered',
  short: 'minus',
};

/** The type menu's order and separators (board Types1). */
const KIND_GROUPS: AnswerKind[][] = [
  ['mcq', 'multiple', 'boolean'],
  ['short', 'open', 'gaps'],
  ['matching', 'ordering', 'drawing'],
];

/** `answer` turned into `kind`: Multiple choice and Multiple answer keep the
 * options, a single choice only its first correct one; any other change
 * starts empty. */
export function answerOfKind(
  answer: QuestionAnswer,
  kind: AnswerKind
): QuestionAnswer {
  if (answer.type === 'mcq' && kind === 'multiple')
    return { ...answer, multiple: true };
  if (answer.type === 'mcq' && kind === 'mcq') {
    const { multiple: _, ...single } = answer;
    return {
      ...single,
      correct: [...answer.correct].sort((a, b) => a - b).slice(0, 1),
    };
  }
  if (kind === 'multiple')
    return {
      correct: [],
      multiple: true,
      options: defaultOptions(),
      type: 'mcq',
    };
  return emptyAnswer(kind);
}

/** The card's answer type menu (board Types1): icons, three groups. */
export function AnswerTypeSelect({
  className,
  onChange,
  value,
}: {
  className?: string;
  onChange: (kind: AnswerKind) => void;
  value: AnswerKind;
}) {
  return (
    <Select
      onValueChange={(next) => onChange(next as AnswerKind)}
      value={value}
    >
      <SelectTrigger
        aria-label={m.question_ui_answer_type()}
        className={cn('h-10 shrink-0', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {KIND_GROUPS.map((group, i) => (
          <SelectGroup key={group[0]}>
            {i > 0 && <SelectSeparator className="my-1" />}
            {group.map((kind) => (
              <SelectItem
                iconAndValue={{
                  icon: kindIcons[kind],
                  label: kindLabels[kind](),
                }}
                key={kind}
                value={kind}
              />
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Correct" after a key's row, in green (board Main). */
function CorrectTag() {
  return (
    <span className="shrink-0 whitespace-nowrap font-bold text-[12.5px] text-tint-success-fg">
      {m.question_ui_status_correct()}
    </span>
  );
}

/** A choice's marker: a radio, or a box for Multiple answer. Checked, it is
 * the correct answer, in green. */
export function ChoiceMarker({
  checked,
  className,
  multiple,
}: {
  checked: boolean;
  className?: string;
  multiple: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // A pixel up, to sit level with its row's text (Epo 2026-11-15).
        'relative -top-px grid size-4.5 shrink-0 place-items-center border-2 border-line-strong text-surface',
        multiple ? 'rounded-[4px]' : 'rounded-full',
        checked && 'border-tint-success-fg bg-tint-success-fg',
        checked && !multiple && 'shadow-[inset_0_0_0_3px_var(--color-surface)]',
        className
      )}
    >
      {checked && multiple && <Icon name="check" size={12} strokeWidth={3} />}
    </span>
  );
}

/** A choice's marker as the button that makes it the correct answer. */
function MarkerButton({
  checked,
  label,
  multiple,
  onClick,
}: {
  checked: boolean;
  label: string;
  multiple: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      // The pixel up as a whole, its hover circle centred on the marker.
      className="relative -top-px -m-2 grid shrink-0 cursor-pointer place-items-center rounded-full p-2 outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action"
      onClick={onClick}
      role={multiple ? 'checkbox' : 'radio'}
      type="button"
    >
      <ChoiceMarker checked={checked} className="top-0" multiple={multiple} />
    </button>
  );
}

/** Focuses the last input under `ref` once `count` grows: the row an Add just
 * made. */
function useFocusAdded(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  const before = useRef(count);
  useEffect(() => {
    if (added.current && count > before.current) {
      const inputs = ref.current?.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >('input, textarea');
      const added = inputs?.[inputs.length - 1];
      // Its default text selected, so typing replaces it.
      added?.focus();
      added?.select();
    }
    added.current = false;
    before.current = count;
  }, [count]);
  return {
    ref,
    willAdd: () => {
      added.current = true;
    },
  };
}

/** Moves the focused row with Alt+ArrowUp or Alt+ArrowDown, focus following
 * it (rows are keyed by place, so the input at `to` holds it next). */
export function moveKeys(
  index: number,
  count: number,
  onMove: (from: number, to: number) => void
) {
  return (event: React.KeyboardEvent<HTMLInputElement>) => {
    const to =
      event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'ArrowDown'
          ? index + 1
          : -1;
    if (!event.altKey || to < 0 || to >= count) return;
    event.preventDefault();
    onMove(index, to);
    event.currentTarget
      .closest('[data-card-list]')
      ?.querySelectorAll('input')
      [to]?.focus();
  };
}

/** `items` with the one at `from` taken out and put back at `to`. */
const moved = <T,>(items: T[], from: number, to: number) => {
  const next = items.filter((_, i) => i !== from);
  next.splice(to, 0, items[from]);
  return next;
};

type MatchingAnswer = Extract<QuestionAnswer, { type: 'matching' }>;

/** A matching answer with column `from` moved to `to`, each row's correct
 * cell following its column. */
export function moveColumn(
  answer: MatchingAnswer,
  from: number,
  to: number
): MatchingAnswer {
  const order = moved(
    answer.options.map((_, i) => i),
    from,
    to
  );
  return {
    ...answer,
    options: order.map((i) => answer.options[i]),
    pairs: answer.pairs.map((pair) => ({
      ...pair,
      right: pair.right < 0 ? pair.right : order.indexOf(pair.right),
    })),
  };
}

/** A matching answer with row `from` moved to `to`, its answer with it. */
export const moveRow = (
  answer: MatchingAnswer,
  from: number,
  to: number
): MatchingAnswer => ({ ...answer, pairs: moved(answer.pairs, from, to) });

/** An ordering answer with item `from` moved to `to`. */
export const moveItems = (
  answer: Extract<QuestionAnswer, { type: 'ordering' }>,
  from: number,
  to: number
) => ({ ...answer, items: moved(answer.items, from, to) });

/** Fields a press inside selects text in rather than dragging the row. */
const TEXT_FIELD =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whole-row drag (Epo 2026-11-15, as Google Forms and the Files panel): a
 * row drags from anywhere outside its text field, an accent line shows where
 * it lands, and `onMove` gets its old and new index. Rows spread
 * `row(i, text)`. */
export function useRowDrag(onMove: (from: number, to: number) => void) {
  const [dragged, setDragged] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(
    null
  );
  const end = () => {
    setDragged(null);
    setDrop(null);
  };
  return (index: number, text: string) => ({
    // The dragged row fades and a straight 2px line marks where it lands,
    // over the row's edge, as a note's block drag draws it (Epo 2026-11-16).
    className: cn(
      'relative rounded-lg',
      dragged === index && 'opacity-50',
      drop?.index === index &&
        'before:pointer-events-none before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:rounded-full before:bg-action-accent',
      drop?.index === index &&
        (drop.after ? 'before:-bottom-px' : 'before:-top-px')
    ),
    onDragEnd: end,
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (dragged === null) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setDrop({ after: event.clientY > rect.top + rect.height / 2, index });
    },
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      setDragged(index);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', text);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (dragged !== null && drop) {
        let to = drop.index + Number(drop.after);
        if (dragged < to) to--;
        if (to !== dragged) onMove(dragged, to);
      }
      end();
    },
    // Draggable only from a press outside the field, so a drag inside its
    // text selects (some browsers drag a draggable row from its input).
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      const target = event.target;
      event.currentTarget.draggable = !(
        target instanceof Element && target.closest(TEXT_FIELD)
      );
    },
  });
}

type ChoiceAnswer = Extract<QuestionAnswer, { type: 'mcq' }>;

/** An mcq with Shuffle options on or off (Epo 2026-11-15); off drops its
 * locked options. */
export function withShuffle(answer: ChoiceAnswer, on: boolean): ChoiceAnswer {
  const { locked: _, shuffle: __, ...rest } = answer;
  return on ? { ...rest, shuffle: true } : rest;
}

/** Multiple choice and Multiple answer (board Main, Types1): each option's
 * radio or box marks it correct; a single choice has one. */
function ChoiceRows({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'mcq' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  const multiple = multipleAnswers(answer);
  const { ref, willAdd } = useFocusAdded(answer.options.length);
  return (
    <div
      aria-label={m.question_ui_options_and_correct_answers()}
      data-card-list=""
      ref={ref}
      role={multiple ? 'group' : 'radiogroup'}
    >
      {answer.options.map((option, i) => {
        const correct = answer.correct.includes(i);
        const locked = answer.locked?.includes(i) ?? false;
        return (
          <div className="flex min-h-11 items-center gap-3" key={i}>
            <MarkerButton
              checked={correct}
              label={m.question_ui_mark_correct({ number: i + 1 })}
              multiple={multiple}
              onClick={() =>
                onChange({
                  ...answer,
                  correct: multiple
                    ? correct
                      ? answer.correct.filter((value) => value !== i)
                      : [...answer.correct, i]
                    : [i],
                })
              }
            />
            <CardInput
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
            {correct && <CorrectTag />}
            {/* Shuffle options: a locked option keeps its place. */}
            {answer.shuffle && (
              <ToolbarButton
                active={locked}
                className={cn(!locked && 'text-fg-muted')}
                label={
                  locked
                    ? m.question_ui_option_locked()
                    : m.question_ui_keep_in_place()
                }
                onClick={() => {
                  const next = locked
                    ? (answer.locked ?? []).filter((value) => value !== i)
                    : [...(answer.locked ?? []), i].sort((a, b) => a - b);
                  onChange({
                    ...answer,
                    locked: next.length ? next : undefined,
                  });
                }}
              >
                <Icon name="lock" />
              </ToolbarButton>
            )}
            <ToolbarButton
              label={m.question_ui_remove_option({ number: i + 1 })}
              onClick={() => {
                const shift = (list: number[]) =>
                  list
                    .filter((value) => value !== i)
                    .map((value) => (value > i ? value - 1 : value));
                const pins = answer.locked && shift(answer.locked);
                onChange({
                  ...answer,
                  correct: shift(answer.correct),
                  locked: pins?.length ? pins : undefined,
                  options: answer.options.filter((_, j) => i !== j),
                });
              }}
            >
              <Icon name="x" />
            </ToolbarButton>
          </div>
        );
      })}
      <AddRow
        disabled={answer.options.length >= limits.QUESTION_ANSWERS_MAX}
        label={m.question_ui_add_option()}
        lead={
          <ChoiceMarker
            checked={false}
            className="border-line"
            multiple={multiple}
          />
        }
        onClick={() => {
          willAdd();
          onChange({
            ...answer,
            options: [
              ...answer.options,
              m.question_default_option({ number: answer.options.length + 1 }),
            ],
          });
        }}
      />
    </div>
  );
}

/** True / False (board Types1): the correct one's radio set. */
function BooleanRows({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'boolean' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  return (
    <div aria-label={m.question_ui_correct_answer()} role="radiogroup">
      {[true, false].map((value) => {
        const label = value ? m.question_ui_true() : m.question_ui_false();
        const correct = answer.correct === value;
        return (
          <div className="flex min-h-11 items-center gap-3" key={label}>
            <MarkerButton
              checked={correct}
              label={label}
              multiple={false}
              onClick={() => onChange({ ...answer, correct: value })}
            />
            {/* Where an option's input puts its text. */}
            <span className="flex-1 px-0.5">{label}</span>
            {correct && <CorrectTag />}
          </div>
        );
      })}
    </div>
  );
}

/** Accepted answers as pills (board Types1): Enter adds what is typed, a
 * pill's text goes back to the input to change, its × removes it. Blank
 * entries never show (saves drop them). */
export function AnswerPills({
  label,
  onChange,
  values,
}: {
  label: string;
  onChange: (values: string[]) => void;
  values: string[];
}) {
  const [draft, setDraft] = useState('');
  const filled = values.filter((value) => value.trim());
  const add = () => {
    const value = draft.trim();
    if (!value || filled.length >= limits.QUESTION_ANSWERS_MAX) return;
    onChange([...filled, value]);
    setDraft('');
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-line border-b pb-1.5 focus-within:border-action-accent">
      {filled.map((value, i) => (
        <span
          className="inline-flex h-7.5 max-w-full items-center gap-0.5 rounded-lg bg-page pl-2.5 text-[13.5px]"
          key={i}
        >
          <button
            className="min-w-0 cursor-text truncate outline-none focus-visible:underline"
            onClick={() => {
              add();
              setDraft(value);
              onChange(filled.filter((_, j) => j !== i));
            }}
            type="button"
          >
            {value}
          </button>
          <ToolbarButton
            className="size-6"
            label={m.question_ui_remove_item({ label, number: i + 1 })}
            onClick={() => onChange(filled.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={14} />
          </ToolbarButton>
        </span>
      ))}
      <input
        aria-label={label}
        className="h-7.5 min-w-32 flex-1 bg-transparent outline-none placeholder:text-fg-muted"
        maxLength={limits.QUESTION_TEXT_MAX}
        onBlur={add}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          add();
        }}
        placeholder={m.question_ui_add_answer()}
        value={draft}
      />
    </div>
  );
}

/** Short answer (board Types1): accepted answers as pills, then the unit. */
function ShortFields({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'short' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  const unitId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span className="t-meta font-semibold text-fg-secondary">
        {m.question_ui_accepted_answers()}
      </span>
      <AnswerPills
        label={m.question_ui_accepted_answers()}
        onChange={(accepted) => onChange({ ...answer, accepted })}
        values={answer.accepted}
      />
      <div className="mt-1.5 flex items-center gap-2.5">
        <label
          className="t-meta font-semibold text-fg-secondary"
          htmlFor={unitId}
        >
          {m.question_ui_unit_optional()}
        </label>
        <FieldInput
          id={unitId}
          maxLength={limits.QUESTION_UNIT_MAX}
          onChange={(event) =>
            onChange({ ...answer, unit: event.target.value || undefined })
          }
          value={answer.unit ?? ''}
          wrapperClassName="w-30"
        />
      </div>
    </div>
  );
}

/** Matching (board Matching): Rows and Columns side by side, each row
 * dragged whole or moved with Alt+ArrowUp/Down (Epo 2026-11-15), then the
 * Correct answers grid with one green cell per row. */
function MatchingFields({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'matching' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  const rows = useFocusAdded(answer.pairs.length);
  const columns = useFocusAdded(answer.options.length);
  const setRow = (index: number, change: Partial<(typeof answer.pairs)[0]>) =>
    onChange({
      ...answer,
      pairs: answer.pairs.map((pair, i) =>
        i === index ? { ...pair, ...change } : pair
      ),
    });
  const shiftRow = (from: number, to: number) =>
    onChange(moveRow(answer, from, to));
  const shiftColumn = (from: number, to: number) =>
    onChange(moveColumn(answer, from, to));
  const rowDrag = useRowDrag(shiftRow);
  const columnDrag = useRowDrag(shiftColumn);
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid @min-[36rem]:grid-cols-2 gap-x-7 gap-y-3">
        <div data-card-list="" ref={rows.ref}>
          <h4 className="mb-1 font-bold">{m.question_ui_rows()}</h4>
          {answer.pairs.map((pair, i) => {
            const { className, ...drag } = rowDrag(i, pair.left);
            return (
              <div
                className={cn('flex min-h-11 items-center gap-3', className)}
                key={i}
                {...drag}
              >
                <span className="w-4.5 shrink-0 cursor-grab">{i + 1}.</span>
                <CardInput
                  aria-label={m.question_ui_numbered_item({
                    label: m.question_ui_rows(),
                    number: i + 1,
                  })}
                  maxLength={limits.QUESTION_TEXT_MAX}
                  onChange={(event) => setRow(i, { left: event.target.value })}
                  onKeyDown={moveKeys(i, answer.pairs.length, shiftRow)}
                  value={pair.left}
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
                  <Icon name="x" />
                </ToolbarButton>
              </div>
            );
          })}
          <AddRow
            disabled={answer.pairs.length >= limits.QUESTION_ANSWERS_MAX}
            label={m.question_ui_add_row()}
            lead={
              <span className="w-4.5 shrink-0 text-fg-muted">
                {answer.pairs.length + 1}.
              </span>
            }
            onClick={() => {
              rows.willAdd();
              onChange({
                ...answer,
                pairs: [
                  ...answer.pairs,
                  {
                    left: m.question_default_row({
                      number: answer.pairs.length + 1,
                    }),
                    right: 0,
                  },
                ],
              });
            }}
          />
        </div>
        <div data-card-list="" ref={columns.ref}>
          <h4 className="mb-1 font-bold">{m.question_ui_columns()}</h4>
          {answer.options.map((option, i) => {
            const { className, ...drag } = columnDrag(i, option);
            return (
              <div
                className={cn('flex min-h-11 items-center gap-3', className)}
                key={i}
                {...drag}
              >
                <ChoiceMarker
                  checked={false}
                  className="cursor-grab"
                  multiple={false}
                />
                <CardInput
                  aria-label={m.question_ui_numbered_item({
                    label: m.question_ui_columns(),
                    number: i + 1,
                  })}
                  maxLength={limits.QUESTION_TEXT_MAX}
                  onChange={(event) =>
                    onChange({
                      ...answer,
                      options: answer.options.map((value, j) =>
                        j === i ? event.target.value : value
                      ),
                    })
                  }
                  onKeyDown={moveKeys(i, answer.options.length, shiftColumn)}
                  value={option}
                />
                <ToolbarButton
                  label={m.question_ui_remove_item({
                    label: m.question_ui_columns(),
                    number: i + 1,
                  })}
                  onClick={() =>
                    onChange({
                      ...answer,
                      options: answer.options.filter((_, j) => j !== i),
                      pairs: answer.pairs.map((pair) => ({
                        ...pair,
                        right:
                          pair.right === i
                            ? -1
                            : pair.right > i
                              ? pair.right - 1
                              : pair.right,
                      })),
                    })
                  }
                >
                  <Icon name="x" />
                </ToolbarButton>
              </div>
            );
          })}
          <AddRow
            disabled={answer.options.length >= limits.QUESTION_ANSWERS_MAX}
            label={m.question_ui_add_column()}
            lead={
              <ChoiceMarker
                checked={false}
                className="border-line"
                multiple={false}
              />
            }
            onClick={() => {
              columns.willAdd();
              onChange({
                ...answer,
                options: [
                  ...answer.options,
                  m.question_default_column({
                    number: answer.options.length + 1,
                  }),
                ],
              });
            }}
          />
        </div>
      </div>
      <div>
        <h4 className="mb-1.5 font-bold">{m.question_ui_correct_answers()}</h4>
        <MatchingGrid
          columns={answer.options}
          correct={answer.pairs.map((pair) => pair.right)}
          label={m.question_ui_correct_answers()}
          onPick={(row, column) => setRow(row, { right: column })}
          rows={answer.pairs.map((pair) => pair.left)}
        />
      </div>
    </div>
  );
}

/** Ordering (board Types1): items written in the right order (members get
 * them shuffled), each row dragged whole with an accent line where it lands;
 * Alt+ArrowUp or Alt+ArrowDown moves the focused one. */
function OrderingRows({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'ordering' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  const { ref, willAdd } = useFocusAdded(answer.items.length);
  const move = (from: number, to: number) =>
    onChange(moveItems(answer, from, to));
  const drag = useRowDrag(move);
  return (
    <div
      aria-label={m.question_ui_items_in_correct_order()}
      data-card-list=""
      ref={ref}
      role="group"
    >
      {answer.items.map((item, i) => {
        const { className, ...row } = drag(i, item);
        return (
          <div
            className={cn('flex min-h-11 items-center gap-3', className)}
            key={i}
            {...row}
          >
            <span className="w-4.5 shrink-0 cursor-grab">{i + 1}.</span>
            <CardInput
              aria-label={m.question_ui_item_number({ number: i + 1 })}
              maxLength={limits.QUESTION_TEXT_MAX}
              onChange={(event) =>
                onChange({
                  ...answer,
                  items: answer.items.map((value, j) =>
                    j === i ? event.target.value : value
                  ),
                })
              }
              onKeyDown={moveKeys(i, answer.items.length, move)}
              value={item}
            />
            <ToolbarButton
              label={m.question_ui_remove_item({
                label: m.question_ui_items_in_correct_order(),
                number: i + 1,
              })}
              onClick={() =>
                onChange({
                  ...answer,
                  items: answer.items.filter((_, j) => j !== i),
                })
              }
            >
              <Icon name="x" />
            </ToolbarButton>
          </div>
        );
      })}
      <AddRow
        disabled={answer.items.length >= limits.QUESTION_ANSWERS_MAX}
        label={m.question_ui_add_item()}
        lead={
          <span className="w-4.5 shrink-0 text-fg-muted">
            {answer.items.length + 1}.
          </span>
        }
        onClick={() => {
          willAdd();
          onChange({
            ...answer,
            items: [
              ...answer.items,
              m.question_default_item({ number: answer.items.length + 1 }),
            ],
          });
        }}
      />
    </div>
  );
}

/** A blank's number as the text shows it (board Types2): an accent chip. */
export function GapChip({ number }: { number: number }) {
  return (
    <span className="inline-flex h-6 min-w-14 items-center justify-center rounded-md bg-tint-accent-1 px-1.5 align-middle font-bold text-[12.5px] text-tint-accent-1-fg">
      {number}
    </span>
  );
}

/** Fill in the blanks' answers (board Types2): each blank's chip, then its
 * accepted answers as pills. */
function GapAnswers({
  answer,
  onChange,
}: {
  answer: Extract<QuestionAnswer, { type: 'gaps' }>;
  onChange: (answer: QuestionAnswer) => void;
}) {
  if (answer.accepted.length === 0)
    return <p className="text-fg-muted text-sm">{m.question_ui_gaps_hint()}</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {answer.accepted.map((accepted, i) => (
        <div className="flex items-center gap-2.5" key={i}>
          <GapChip number={i + 1} />
          <div className="min-w-0 flex-1">
            <AnswerPills
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
        </div>
      ))}
    </div>
  );
}

/** A long answer's or drawing's marking points (board Types2): each with
 * its marks, adding up to the part's. */
export function MarkSchemeRows({
  field,
  items,
  max,
  onChange,
}: {
  /** A point's text, edited in place with formulas (Epo 2026-11-16). */
  field: (
    text: string,
    onText: (text: string) => void,
    /** A point just added, which opens in its editor. */
    added: boolean
  ) => ReactNode;
  items: MarkItem[];
  /** Marking items a part holds at most (a quiz's bound is lower). */
  max: number;
  /** The items and the marks they add up to. */
  onChange: (items: MarkItem[], marks: number) => void;
}) {
  const [added, setAdded] = useState<number | null>(null);
  const total = items.reduce((sum, item) => sum + item.marks, 0);
  const set = (next: MarkItem[]) => onChange(next, schemeMarks(next));
  const label = m.question_ui_marking_scheme();
  return (
    <div data-card-list="">
      <h4 className="mb-1 font-bold">{label}</h4>
      {items.map((item, i) => (
        // Top-aligned (Epo 2026-11-15): a point that wraps keeps its number and
        // controls on its first line.
        <div
          className="grid min-h-11 grid-cols-[1.375rem_minmax(0,1fr)_3.25rem_auto] items-start gap-2.5 py-0.5"
          key={i}
        >
          <span className="pt-2 leading-[1.7]">{i + 1}.</span>
          <div className="min-w-0">
            {field(
              item.text,
              (text) =>
                set(items.map((row, j) => (j === i ? { ...row, text } : row))),
              i === added
            )}
          </div>
          {/* Up to what the part's marks leave over the other items. */}
          <MarksInput
            className="mt-1"
            label={m.question_ui_item_marks({ number: i + 1 })}
            max={Math.max(
              item.marks,
              limits.QUESTION_MARKS_MAX - total + item.marks
            )}
            onChange={(marks) =>
              set(items.map((row, j) => (j === i ? { ...row, marks } : row)))
            }
            value={item.marks}
          />
          <ToolbarButton
            className="mt-[calc((40px-var(--toolbar-button))/2)]"
            label={m.question_ui_remove_item({ label, number: i + 1 })}
            onClick={() => set(items.filter((_, j) => j !== i))}
          >
            <Icon name="x" />
          </ToolbarButton>
        </div>
      ))}
      <AddRow
        disabled={items.length >= max || total >= limits.QUESTION_MARKS_MAX}
        label={m.question_ui_add_mark_point()}
        lead={<span className="w-5.5 shrink-0" />}
        onClick={() => {
          setAdded(items.length);
          set([
            ...items,
            { marks: 1, text: m.question_default_marking_point() },
          ]);
        }}
      />
    </div>
  );
}

/** A closed answer's key inside the open card, by type: choices, True /
 * False, accepted answers, matching's grid, ordering's rows and the blanks'
 * answers. Long answers and drawings mark against `MarkSchemeRows`. */
export function AnswerEditor({
  answer,
  onChange,
}: {
  answer: QuestionAnswer;
  onChange: (answer: QuestionAnswer) => void;
}) {
  switch (answer.type) {
    case 'mcq':
      return <ChoiceRows answer={answer} onChange={onChange} />;
    case 'boolean':
      return <BooleanRows answer={answer} onChange={onChange} />;
    case 'short':
      return <ShortFields answer={answer} onChange={onChange} />;
    case 'matching':
      return <MatchingFields answer={answer} onChange={onChange} />;
    case 'ordering':
      return <OrderingRows answer={answer} onChange={onChange} />;
    case 'gaps':
      return <GapAnswers answer={answer} onChange={onChange} />;
    case 'open':
    case 'drawing':
      return null;
  }
}
